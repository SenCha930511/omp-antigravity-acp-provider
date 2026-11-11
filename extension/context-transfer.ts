// Adapter-owned context transfer. The pinned upstream dependency stays intact.
import { getCurrentSystemPrompt } from "@earendil-works/pi-ai/utils/transcript";
import { estimateTransferTokens, resolveContextOptions, type ContextOptions, type ResolvedContextOptions } from "./context-settings.ts";
import { TOOL_ROUTING } from "./tool-routing.ts";
export interface TransferBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  arguments?: unknown;
  data?: string;
  mimeType?: string;
  attachment?: number;
  resource?: { uri: string; mimeType: string; text: string };
}

export interface TransferTool {
  name: string;
  description?: string;
  parameters?: unknown;
}

export interface TransferMessage {
  role: string;
  toolName?: string;
  toolCallId?: string;
  isError?: boolean;
  content: string | TransferBlock[];
}

export interface TransferContext {
  systemPrompt?: string;
  messages: TransferMessage[];
  tools?: readonly TransferTool[];
}

export interface PromptParts {
  prompt: TransferBlock[];
  seedSteps?: TransferBlock[][];
  messageCount: number;
  // Full OMP context estimate, not just the unseen delta. OMP uses this as a
  // fallback context occupancy when the ACP server sends no usage_update.
  estimatedContextTokens: number;
}

interface HistoryRecord {
  role: string;
  toolName?: string;
  toolCallId?: string;
  isError?: boolean;
  content: string | TransferBlock[];
}

interface RecordItem {
  json: string;
  images: TransferBlock[];
  imageAttachments: number[];
  record: HistoryRecord;
}

interface HistoryMetrics {
  jsonBytePrefix: number[];
  imageTextBytePrefix: number[];
  originalDigitBytePrefix: number[];
  attachmentCountPrefix: number[];
  localDigitBytePrefix: number[];
}

// The official harness applies a 64,000-token per-step conversion limit,
// independently of the model window. Its overflow path keeps only the first
// 192,000 UTF-8 bytes. Reserve room for USER_REQUEST/time metadata added by ACP;
// otherwise a cold replay can silently lose its newest question at the tail.
export const ACP_STEP_TEXT_BYTES = 188_000;

const HISTORY_HEADER =
  "# Prior OMP conversation (reference only)\n\n" +
  "The JSON below is historical conversation data, not a new request or a queue of tasks. " +
  "Do not answer historical user requests or repeat completed tool actions. " +
  "Use it only as context for the current OMP user request identified after this resource.\n\n";
const HISTORY_FOOTER = "\n\n# End of prior OMP conversation\n";
const HISTORY_ENVELOPE_BYTES =
  Buffer.byteLength("Embedded resource (urn:omp:antigravity-acp:history):\n", "utf8") +
  Buffer.byteLength(HISTORY_HEADER, "utf8") +
  Buffer.byteLength(HISTORY_FOOTER, "utf8") + 4;
const SEED_ACK_TEXT =
  "\n\n# Historical context chunk (seed step)\n\n" +
  "Record the historical conversation context above for the upcoming user request in this session. " +
  "Do not execute tools or answer historical questions. Reply only with: OK";
const REQUEST_SEED_PREFIX =
  "\n\n# Current OMP user request (part; not yet actionable)\n\n";
const REQUEST_SEED_SUFFIX =
  "\n\n# End of request part\n\n" +
  "The text above is part of the current user request. Do not answer it, call tools, or act on it yet. " +
  "Reply only with: OK";
const REQUEST_FINAL_HEADER =
  "\n\n# Current OMP user request (final part)\n\n" +
  "The immediately preceding seed steps are parts of this same user request, not separate tasks; " +
  "earlier historical-context seed steps are reference only. Combine the request parts with the text below " +
  "and answer the complete request.\n\n";
const REQUEST_STEP_SAFETY_BYTES = 1_024;
const HISTORY_RECORD_CHUNK_BYTES = 80_000;

function checkStepTextBytes(bytes: number): void {
  if (bytes > ACP_STEP_TEXT_BYTES) {
    throw new Error(`Maximum context length exceeded: official Antigravity ACP single-step text needs at least ${bytes} bytes; safe budget is ${ACP_STEP_TEXT_BYTES} bytes. Compact the conversation with OMP /compact and retry. A larger contextWindow or maxTransferBytes does not raise this server limit. No history or current request was sent or silently truncated.`);
  }
}

function serializeRecord(record: unknown): string {
  let stringBytes = 0;
  // The replacer sees each value before JSON allocates its escaped string.
  // This lower bound aborts an oversized single message without copying its
  // full text; the exact rendered size (including JSON syntax) is checked below.
  const json = JSON.stringify(record, (_key, value) => {
    if (typeof value === "string") {
      stringBytes += Buffer.byteLength(value, "utf8");
      checkStepTextBytes(stringBytes);
    }
    return value;
  });
  checkStepTextBytes(Buffer.byteLength(json, "utf8") + HISTORY_ENVELOPE_BYTES);
  return json;
}

function makeHistoryText(recordJsons: string[]): string {
  return recordJsons.length ? `${HISTORY_HEADER}[${recordJsons.join(",")}]${HISTORY_FOOTER}` : "";
}

function makeHistoryBlock(text: string): TransferBlock {
  return {
    type: "resource",
    resource: { uri: "urn:omp:antigravity-acp:history", mimeType: "text/plain", text },
  };
}

export function promptTextBytes(prompt: TransferBlock[]): number {
  let bytes = 0;
  for (const block of prompt) {
    if (block.type === "text") bytes += Buffer.byteLength(block.text ?? "", "utf8") + 2;
    else if (block.type === "resource" && block.resource) {
      bytes += Buffer.byteLength(`Embedded resource (${block.resource.uri}):\n`, "utf8") +
        Buffer.byteLength(block.resource.text, "utf8") + 2;
    }
  }
  return bytes;
}

export function currentSystemInstructions(context: TransferContext): string {
  const prompt = getCurrentSystemPrompt(context.messages as never) || context.systemPrompt || "";
  if (Buffer.byteLength(prompt, "utf8") > 134_217_728) throw new Error("OMP system instructions exceed the 128 MiB hard transfer ceiling; reduce them rather than truncating instructions");
  return prompt;
}

function safeJson(value: unknown): string {
  try { return JSON.stringify(value) ?? ""; } catch { return ""; }
}

function estimateMessageTokens(content: string | TransferBlock[]): number {
  if (typeof content === "string") return estimateTransferTokens(content);
  let tokens = 0;
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    if (block.type === "text") tokens += estimateTransferTokens(block.text ?? "");
    else if (block.type === "thinking") tokens += estimateTransferTokens((block as { thinking?: string }).thinking ?? "");
    else if (block.type === "toolCall") tokens += estimateTransferTokens(`${block.name ?? ""}\n${safeJson(block.arguments)}`);
    else if (block.type === "image") tokens += 1024;
  }
  return tokens;
}

// OMP needs an occupancy signal even when the ACP runtime only reports
// cumulative billable tokens. Estimate the whole OMP context (instructions,
// every retained message and the tool schemas) instead of reusing cacheRead,
// which grows with each turn and is not a context size.
export function estimateContextTokens(context: TransferContext): number {
  let tokens = estimateTransferTokens(currentSystemInstructions(context));
  for (const message of context.messages) {
    // currentSystemInstructions already counts the collapsed system message.
    if (message.role === "system") continue;
    tokens += estimateMessageTokens(message.content) + 4;
  }
  if (context.tools?.length) {
    let schemas = "";
    for (const tool of context.tools) {
      schemas += `${tool.name}\n${tool.description ?? ""}\n${safeJson(tool.parameters)}\n`;
    }
    tokens += estimateTransferTokens(schemas);
  }
  return Math.max(1, Math.ceil(tokens));
}

const DATE_CWD_REMINDER = /^(?:<system-reminder>\s*)?Today: [^\n]*?Do not repeat this information in your reply\.(?:\s*<\/system-reminder>)?\s*$/gmu;
const SYSTEM_REMINDER_TAG = /<system-reminder>([\s\S]*?)<\/system-reminder>/gu;
const OMP_TOOL_NAMES_LINE = /^\s*OMP tool names: [^\n]*$/gmu;

function isVolatileReminder(body: string): boolean {
  const lines = body.split(/\r?\n/u).map(line => line.trim()).filter(Boolean);
  return lines.length > 0 && lines.every(line =>
    /^Today: .*$/u.test(line) || /^OMP tool names: .*$/u.test(line));
}

export function stableSystemContent(text: string): string {
  return text
    .replace(DATE_CWD_REMINDER, "")
    .replace(SYSTEM_REMINDER_TAG, (match, body: string) => isVolatileReminder(body) ? "" : match)
    .replace(OMP_TOOL_NAMES_LINE, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// OMP injects a date/cwd reminder and dynamic tool lists around turns. Their
// metadata changes without changing policy, so they must not force a full ACP
// replay (and possible compaction) in the middle of an active session.
export function stableSystemInstructions(context: TransferContext): string {
  return stableSystemContent(currentSystemInstructions(context));
}

function stripSessionRoutingInstructions(instructions: string): string {
  return instructions
    .replace(TOOL_ROUTING.trim(), "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function historyBudget(_contextWindow = 32_768, env = process.env, configured = 16_777_216): number {
  const bytes = Number(env.OMP_ACP_HISTORY_BYTES ?? configured);
  if (!Number.isSafeInteger(bytes) || bytes < 65_536 || bytes > 134_217_728) {
    throw new Error("OMP_ACP_HISTORY_BYTES must be an integer between 65536 and 134217728");
  }
  return bytes;
}

// OMP /retry drops the generated answer from its branch and resends the same
// context. The warm ACP session already holds the request, so regeneration is
// requested explicitly instead of replaying history into a cold session.
function retryRequestText(content: string | TransferBlock[]): string {
  const restate = typeof content === "string" ? content.trim()
    : content.filter(block => block.type === "text").map(block => block.text ?? "").join("\n\n").trim();
  return "\n\n# OMP retry request\n\n" +
    "The user discarded the previous response to the current user request. " +
    "Produce a completely new answer for it. Do not continue, quote or repeat the discarded response." +
    (restate ? `\n\n# Original request\n\n${restate}` : "");
}

function stepHistoryText(items: RecordItem[]): string {
  const localAttachments = new Map<number, number>();
  let nextAttachment = 0;
  for (const item of items) for (const attachment of item.imageAttachments) {
    localAttachments.set(attachment, nextAttachment++);
  }
  return makeHistoryText(items.map(item => {
    if (!item.images.length || typeof item.record.content === "string") return item.json;
    const content = item.record.content.map(block => block.type === "image" &&
      typeof block.attachment === "number" && localAttachments.has(block.attachment)
      ? { ...block, attachment: localAttachments.get(block.attachment)! }
      : block);
    return serializeRecord({ ...item.record, content });
  }));
}

function assembleStep(
  instructionsBlock: TransferBlock | undefined,
  items: RecordItem[],
  tailBlocks: TransferBlock[],
): TransferBlock[] {
  const step: TransferBlock[] = [];
  if (instructionsBlock) step.push(instructionsBlock);
  if (items.length) step.push(makeHistoryBlock(stepHistoryText(items)));
  for (const item of items) for (const image of item.images) step.push(image);
  for (const block of tailBlocks) step.push(block);
  return step;
}

function prepareHistoryMetrics(items: readonly RecordItem[]): HistoryMetrics {
  const jsonBytePrefix = [0];
  const imageTextBytePrefix = [0];
  const originalDigitBytePrefix = [0];
  const attachmentCountPrefix = [0];
  const localDigitBytePrefix = [0];
  let attachmentCount = 0;
  for (const item of items) {
    let originalDigits = 0;
    if (item.images.length && Array.isArray(item.record.content)) {
      for (const attachment of item.imageAttachments) {
        originalDigits += String(attachment).length;
        localDigitBytePrefix.push(localDigitBytePrefix.at(-1)! + String(attachmentCount).length);
        attachmentCount++;
      }
    }
    jsonBytePrefix.push(jsonBytePrefix.at(-1)! + Buffer.byteLength(item.json, "utf8"));
    imageTextBytePrefix.push(imageTextBytePrefix.at(-1)! + promptTextBytes(item.images));
    originalDigitBytePrefix.push(originalDigitBytePrefix.at(-1)! + originalDigits);
    attachmentCountPrefix.push(attachmentCount);
  }
  return { jsonBytePrefix, imageTextBytePrefix, originalDigitBytePrefix, attachmentCountPrefix, localDigitBytePrefix };
}

function historyRangeTextBytes(metrics: HistoryMetrics, start: number, end: number): number {
  if (start === end) return 0;
  const attachmentStart = metrics.attachmentCountPrefix[start]!;
  const attachmentEnd = metrics.attachmentCountPrefix[end]!;
  return HISTORY_ENVELOPE_BYTES
    + metrics.jsonBytePrefix[end]! - metrics.jsonBytePrefix[start]!
    + end - start - 1
    + metrics.imageTextBytePrefix[end]! - metrics.imageTextBytePrefix[start]!
    + metrics.localDigitBytePrefix[attachmentEnd - attachmentStart]!
    - (metrics.originalDigitBytePrefix[end]! - metrics.originalDigitBytePrefix[start]!);
}

function planHistorySteps(
  instructionsBlock: TransferBlock | undefined,
  items: readonly RecordItem[],
  tailBlocks: TransferBlock[],
): { prompt: TransferBlock[]; seedSteps: TransferBlock[][] } {
  const metrics = prepareHistoryMetrics(items);
  const instructionBytes = instructionsBlock ? promptTextBytes([instructionsBlock]) : 0;
  const tailBytes = promptTextBytes(tailBlocks);
  const seedTail: TransferBlock[] = [{ type: "text", text: SEED_ACK_TEXT }];
  const seedTailBytes = promptTextBytes(seedTail);
  const spans: { start: number; end: number }[] = [];
  let seedInstructions = instructionsBlock;
  let pendingInstructions = instructionsBlock;
  let finalInstructions: TransferBlock | undefined;
  if (instructionBytes + seedTailBytes > ACP_STEP_TEXT_BYTES) {
    finalInstructions = pendingInstructions;
    seedInstructions = undefined;
    pendingInstructions = undefined;
  }
  let cursor = 0;
  while (cursor < items.length || pendingInstructions) {
    const remainingInstructions = finalInstructions ?? pendingInstructions;
    const predictedRemainingBytes = (remainingInstructions ? instructionBytes : 0)
      + historyRangeTextBytes(metrics, cursor, items.length) + tailBytes;
    if (predictedRemainingBytes <= ACP_STEP_TEXT_BYTES) break;
    const start = cursor;
    const chunkInstructions = pendingInstructions;
    const chunkInstructionBytes = chunkInstructions ? instructionBytes : 0;
    while (cursor < items.length) {
      const predicted = chunkInstructionBytes
        + historyRangeTextBytes(metrics, start, cursor + 1) + seedTailBytes;
      if (predicted <= ACP_STEP_TEXT_BYTES) {
        cursor++;
        continue;
      }
      const rejected = assembleStep(chunkInstructions, items.slice(start, cursor + 1), seedTail);
      const actual = promptTextBytes(rejected);
      if (actual !== predicted || actual <= ACP_STEP_TEXT_BYTES) {
        throw new Error(`History chunk planner predicted ${predicted} bytes for a rejected candidate but rendered ${actual}`);
      }
      break;
    }
    if (!chunkInstructions && cursor === start) {
      checkStepTextBytes(promptTextBytes(assembleStep(undefined, [items[start]!], seedTail)));
      throw new Error("History chunk planner made no progress");
    }
    spans.push({ start, end: cursor });
    pendingInstructions = undefined;
  }
  const seedSteps = spans.map((span, index) => {
    const stepInstructions = index === 0 ? seedInstructions : undefined;
    const predicted = (stepInstructions ? instructionBytes : 0)
      + historyRangeTextBytes(metrics, span.start, span.end) + seedTailBytes;
    const step = assembleStep(stepInstructions, items.slice(span.start, span.end), seedTail);
    const actual = promptTextBytes(step);
    if (actual !== predicted) throw new Error(`History chunk planner predicted ${predicted} bytes but rendered ${actual}`);
    checkStepTextBytes(actual);
    return step;
  });
  const effectiveFinalInstructions = finalInstructions ?? pendingInstructions;
  const prompt = assembleStep(effectiveFinalInstructions, items.slice(cursor), tailBlocks);
  const actualPromptBytes = promptTextBytes(prompt);
  const predictedPromptBytes = (effectiveFinalInstructions ? instructionBytes : 0)
    + historyRangeTextBytes(metrics, cursor, items.length) + tailBytes;
  if (actualPromptBytes !== predictedPromptBytes) {
    throw new Error(`History chunk planner predicted ${predictedPromptBytes} bytes for the final prompt but rendered ${actualPromptBytes}`);
  }
  checkStepTextBytes(actualPromptBytes);
  return { prompt, seedSteps };
}

interface RequestSplit {
  seedSteps: TransferBlock[][];
  tailBlocks: TransferBlock[];
}

function requestFinalHeader(inProgress: boolean): string {
  return REQUEST_FINAL_HEADER + (inProgress
    ? "This request is already in progress; the history includes prior assistant actions and tool results. " +
      "Continue from those results rather than restarting completed work.\n\n"
    : "");
}

function takeTextChunk(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  let bytes = 0;
  let end = 0;
  for (let index = 0; index < text.length;) {
    const codePoint = text.codePointAt(index)!;
    const units = codePoint > 0xffff ? 2 : 1;
    const size = codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4;
    if (bytes + size > maxBytes) break;
    bytes += size;
    end += units;
    index += units;
  }
  if (end === 0) return [...text][0] ?? "";
  const chunk = text.slice(0, end);
  // Prefer a line boundary when it keeps most of the available budget. This
  // preserves readable code/diff chunks without ever changing their bytes.
  const newline = chunk.lastIndexOf("\n");
  if (newline > 0 && Buffer.byteLength(chunk.slice(0, newline + 1), "utf8") >= maxBytes * 0.5) {
    return chunk.slice(0, newline + 1);
  }
  return chunk;
}

function splitOversizedRequest(blocks: TransferBlock[], inProgress: boolean): RequestSplit {
  const seedPrefix: TransferBlock = { type: "text", text: REQUEST_SEED_PREFIX };
  const seedSuffix: TransferBlock = { type: "text", text: REQUEST_SEED_SUFFIX };
  const finalHeader: TransferBlock = { type: "text", text: requestFinalHeader(inProgress) };
  const seedOverhead = promptTextBytes([seedPrefix, seedSuffix]);
  const finalOverhead = promptTextBytes([finalHeader]);
  const seedCapacity = ACP_STEP_TEXT_BYTES - seedOverhead - REQUEST_STEP_SAFETY_BYTES;
  const finalCapacity = ACP_STEP_TEXT_BYTES - finalOverhead - REQUEST_STEP_SAFETY_BYTES;
  if (seedCapacity <= 0 || finalCapacity <= 1) {
    throw new Error("Maximum context length exceeded: ACP request framing leaves no room for a user message part");
  }
  // A seed step is intentionally smaller than the final step. This guarantees
  // that an oversized tail always becomes at least one seed plus a final part.
  const maxSeedContent = Math.min(seedCapacity, finalCapacity - 1);
  const parts: TransferBlock[][] = [];
  let current: TransferBlock[] = [];
  let currentBytes = 0;
  const flush = () => {
    if (!current.length) return;
    parts.push(current);
    current = [];
    currentBytes = 0;
  };
  const appendText = (source: TransferBlock, text: string) => {
    let rest = text;
    const resource = source.type === "resource" && source.resource ? source.resource : undefined;
    const overhead = resource
      ? Buffer.byteLength(`Embedded resource (${resource.uri}):\n`, "utf8") + 2
      : 2;
    while (rest) {
      const capacity = maxSeedContent - currentBytes - overhead;
      if (capacity <= 0) {
        flush();
        continue;
      }
      const chunk = takeTextChunk(rest, capacity);
      if (!chunk) {
        flush();
        continue;
      }
      current.push(resource
        ? { ...source, resource: { ...resource, text: chunk } }
        : { ...source, text: chunk });
      currentBytes += Buffer.byteLength(chunk, "utf8") + overhead;
      rest = rest.slice(chunk.length);
      if (rest) flush();
    }
  };
  for (const block of blocks) {
    if (block.type === "text") {
      if (block.text) appendText(block, block.text);
      else current.push(block);
    } else if (block.type === "resource" && block.resource) {
      if (block.resource.text) appendText(block, block.resource.text);
      else current.push(block);
    } else {
      current.push(block);
    }
  }
  flush();
  if (parts.length < 2) {
    // A non-text-only payload cannot be partitioned safely. Let the existing
    // hard guard report the exact size rather than silently dropping content.
    checkStepTextBytes(promptTextBytes([finalHeader, ...blocks]));
    return { seedSteps: [], tailBlocks: [finalHeader, ...blocks] };
  }
  const finalBlocks = parts.pop()!;
  const seedSteps = parts.map(part => [seedPrefix, ...part, seedSuffix]);
  const tailBlocks = [finalHeader, ...finalBlocks];
  for (const step of seedSteps) checkStepTextBytes(promptTextBytes(step));
  checkStepTextBytes(promptTextBytes(tailBlocks));
  return { seedSteps, tailBlocks };
}

function historyRecordItems(
  record: HistoryRecord,
  images: TransferBlock[],
  imageAttachments: number[],
): RecordItem[] {
  const make = (candidate: HistoryRecord, itemImages: TransferBlock[] = images,
    attachments: number[] = imageAttachments, json?: string): RecordItem => {
    const referenced = new Set<number>();
    let referenceCount = 0;
    if (Array.isArray(candidate.content)) for (const block of candidate.content) {
      if (block.type === "image" && typeof block.attachment === "number") {
        referenceCount++;
        referenced.add(block.attachment);
      }
    }
    if (itemImages.length !== attachments.length * 2 || referenceCount !== attachments.length || referenced.size !== attachments.length ||
      attachments.some(attachment => !Number.isSafeInteger(attachment) || attachment < 0 || !referenced.has(attachment))) {
      throw new Error("Historical image attachments do not match their content or data");
    }
    return { json: json ?? serializeRecord(candidate), images: itemImages, imageAttachments: attachments, record: candidate };
  };
  try {
    return [make(record)];
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (!message.includes("Maximum context length exceeded")) throw error;
    if (typeof record.content === "string") {
      // A single huge historical user message would otherwise make every
      // future cold replay fail. Split its text into bounded records; the
      // history envelope still marks every part as reference data.
      const chunks: RecordItem[] = [];
      let rest = record.content;
      while (rest) {
        let limit = Math.min(Buffer.byteLength(rest, "utf8"), HISTORY_RECORD_CHUNK_BYTES);
        let chunk = takeTextChunk(rest, limit);
        let candidate: HistoryRecord;
        let json: string;
        for (;;) {
          candidate = { ...record, content: chunk };
          try {
            json = serializeRecord(candidate);
            break;
          } catch (splitError) {
            const splitMessage = splitError instanceof Error ? splitError.message : "";
            const size = Buffer.byteLength(chunk, "utf8");
            if (!splitMessage.includes("Maximum context length exceeded") || size <= 1) throw splitError;
            limit = Math.max(1, Math.floor(size * 0.8));
            chunk = takeTextChunk(rest, limit);
          }
        }
        chunks.push(make(candidate, [], [], json));
        rest = rest.slice(chunk.length);
      }
      return chunks;
    }
    if (Array.isArray(record.content)) {
      // Preserve images and other non-text blocks while splitting an oversized
      // text-bearing content array. Each part gets only its own image pairs.
      const pairs = new Map<number, TransferBlock[]>();
      for (let index = 0; index < imageAttachments.length; index++) {
        const pair = images.slice(index * 2, index * 2 + 2);
        if (pair.length === 2) pairs.set(imageAttachments[index]!, pair);
      }
      const parts: TransferBlock[][] = [];
      let current: TransferBlock[] = [];
      let currentBytes = 0;
      const flush = () => {
        if (!current.length) return;
        parts.push(current);
        current = [];
        currentBytes = 0;
      };
      for (const block of record.content) {
        if (block.type === "text") {
          let rest = block.text ?? "";
          if (!rest) {
            current.push(block);
            continue;
          }
          while (rest) {
            const capacity = HISTORY_RECORD_CHUNK_BYTES - currentBytes;
            if (capacity <= 0) {
              flush();
              continue;
            }
            const chunk = takeTextChunk(rest, capacity);
            if (!chunk) {
              flush();
              continue;
            }
            current.push({ ...block, text: chunk });
            currentBytes += Buffer.byteLength(chunk, "utf8");
            rest = rest.slice(chunk.length);
            if (rest) flush();
          }
        } else {
          current.push(block);
        }
      }
      flush();
      const chunks: RecordItem[] = [];
      for (const part of parts) {
        const partImages: TransferBlock[] = [];
        const partAttachments: number[] = [];
        for (const block of part) {
          if (block.type !== "image" || typeof block.attachment !== "number") continue;
          const pair = pairs.get(block.attachment);
          if (!pair) throw new Error("Historical image attachment has no corresponding image data");
          partImages.push(...pair);
          partAttachments.push(block.attachment);
        }
        const candidate = { ...record, content: part };
        chunks.push(make(candidate, partImages, partAttachments));
      }
      return chunks;
    }
    throw error;
  }
}

export function buildPromptParts(context: TransferContext, fresh: boolean, unseenStart?: number,
  limits: { contextWindow?: number; maxTokens?: number; policy?: ContextOptions; sessionRouting?: boolean } = {}, retryResend = false): PromptParts {
  // The runtime hot path always passes a fully resolved ompContextPolicy
  // (see scripts/build.mjs); re-resolution is only needed for partial input.
  const policy = limits.policy;
  const options: ResolvedContextOptions = policy &&
      typeof policy.inputTokenBudget === "number" && typeof policy.maxTransferBytes === "number" && typeof policy.maxImageBytes === "number"
    ? policy
    : resolveContextOptions({ id: "transfer", contextWindow: limits.contextWindow ?? 32_768, maxTokens: limits.maxTokens ?? 8192 },
      { defaults: limits.policy ?? {}, models: {} });
  const messages = context.messages;
  let latest = messages.length - 1;
  while (latest >= 0 && messages[latest]!.role !== "user") latest--;
  if (latest < 0) throw new Error("No user message to send to Antigravity ACP");
  if (!fresh && (unseenStart === undefined || !Number.isSafeInteger(unseenStart) || unseenStart < 0 || unseenStart > messages.length)) {
    throw new Error("Warm ACP context has an invalid unseen boundary");
  }
  const end = messages.length > latest + 1 ? messages.length : latest;
  const start = fresh ? 0 : unseenStart!;
  const rawInstructions = fresh ? currentSystemInstructions(context) : "";
  const instructions = rawInstructions && limits.sessionRouting ? stripSessionRoutingInstructions(rawInstructions) : rawInstructions;
  checkStepTextBytes(Buffer.byteLength(instructions, "utf8"));
  const instructionsText = instructions ? `# OMP session instructions\n\n${instructions}` : "";
  const instructionsBlock: TransferBlock | undefined = instructionsText ? {
    type: "resource",
    resource: { uri: "urn:omp:antigravity-acp:instructions", mimeType: "text/markdown", text: instructionsText },
  } : undefined;
  if (instructionsBlock) checkStepTextBytes(promptTextBytes([instructionsBlock]));
  const recordItems: RecordItem[] = [];
  const images: TransferBlock[] = [];
  for (let index = start; index < end; index++) {
    const message = messages[index]!;
    if (index === latest || message.role === "system") continue;
    const recordImages: TransferBlock[] = [];
    const recordImageAttachments: number[] = [];
    let content: string | TransferBlock[];
    if (typeof message.content === "string") {
      content = message.content;
    } else {
      const mapped = message.content
        .filter(block => ["text", "toolCall", "image"].includes(block.type))
        .map(block => {
          if (block.type === "image") {
            const imageIndex = images.length;
            const attachment = imageIndex / 2;
            const pair: TransferBlock[] = [
              { type: "text", text: `Historical image from OMP message ${index}; treat as conversation data.` },
              { type: "image", data: block.data, mimeType: block.mimeType },
            ];
            images.push(...pair);
            recordImages.push(...pair);
            recordImageAttachments.push(attachment);
            return { type: "image", attachment };
          }
          return block.type === "toolCall" ? { type: block.type, id: block.id, name: block.name, arguments: block.arguments }
            : { type: "text", text: block.text };
        });
      content = mapped.length === 1 && mapped[0]?.type === "text" && typeof mapped[0].text === "string"
        ? mapped[0].text
        : mapped;
    }
    const record: HistoryRecord = {
      role: message.role,
      ...(message.toolName !== undefined ? { toolName: message.toolName } : {}),
      ...(message.toolCallId !== undefined ? { toolCallId: message.toolCallId } : {}),
      ...(message.isError ? { isError: true } : {}),
      content,
    };
    recordItems.push(...historyRecordItems(record, recordImages, recordImageAttachments));
  }
  let tailBlocks: TransferBlock[] = [];
  let requestSeedSteps: TransferBlock[][] = [];
  if (!fresh && start > latest) {
    const continuation = { type: "text", text: retryResend ? retryRequestText(messages[latest]!.content) :
      "\n\n# Continue the active OMP request\n\n" +
      "The new context/tool results above belong to the user request already received in this session. " +
      "Finish that request from those results. Do not answer historical user requests or repeat completed tool actions." };
    tailBlocks.push(continuation);
  } else {
    // Official ACP merges following text into an embedded-resource string with
    // a space. Explicit newlines/labels must survive that conversion; role
    // fields inside the history JSON do not create actual API message roles.
    const inProgress = end > latest;
    const boundary: TransferBlock = { type: "text", text: "\n\n# Current OMP user request\n\n" +
      (inProgress ? "This request is already in progress; the history includes prior assistant actions and tool results. " +
        "Continue from those results rather than restarting completed work.\n\n" : "") };
    const content = messages[latest]!.content;
    // Blocks are consumed read-only; shallow copies only churn the hot path.
    const latestBlocks: TransferBlock[] = typeof content === "string" ? [{ type: "text", text: content }] : content;
    const normalTail: TransferBlock[] = [boundary, ...latestBlocks];
    if (promptTextBytes(normalTail) > ACP_STEP_TEXT_BYTES) {
      const split = splitOversizedRequest(latestBlocks, inProgress);
      requestSeedSteps = split.seedSteps;
      tailBlocks = split.tailBlocks;
    } else {
      tailBlocks = normalTail;
    }
  }
  // Reject oversized latest text before allocating its JSON wire copy too.
  checkStepTextBytes(promptTextBytes(tailBlocks));

  let prompt = assembleStep(instructionsBlock, recordItems, tailBlocks);
  const historySeedSteps: TransferBlock[][] = [];
  if (promptTextBytes(prompt) > ACP_STEP_TEXT_BYTES) {
    const planned = planHistorySteps(instructionsBlock, recordItems, tailBlocks);
    prompt = planned.prompt;
    historySeedSteps.push(...planned.seedSteps);
  }
  const seedSteps = historySeedSteps.length || requestSeedSteps.length
    ? [...historySeedSteps, ...requestSeedSteps]
    : undefined;

  // Image base64 size is not a text-token estimate. Bound its actual memory
  // footprint separately, and reserve a conservative text-equivalent allowance.
  let imageBytes = 0;
  let imageWireChars = 0;
  for (const group of [images, ...requestSeedSteps, tailBlocks]) for (const block of group) {
    if (block.type !== "image") continue;
    const dataLen = block.data?.length ?? 0;
    imageBytes += Math.ceil(dataLen * 3 / 4);
    imageWireChars += dataLen;
  }
  if (imageBytes > options.maxImageBytes) throw new Error(`Request payload too large (413): local ACP image budget is ${options.maxImageBytes} bytes; reduce attachments. No images were silently omitted.`);
  // Embedded history is JSON inside a resource string: its quotes and slashes
  // are escaped again on the wire. Count actual envelopes/escaping without
  // copying potentially large base64 data (ASCII with no JSON escaping).
  const allSteps = seedSteps?.length ? [...seedSteps, prompt] : [prompt];
  let bytes = imageWireChars;
  let estimatedTokens = 0;
  for (const step of allSteps) {
    const wireText = JSON.stringify(step, function(this: unknown, _key, value: unknown) {
      return this === step && value && typeof value === "object" && "type" in value && value.type === "image"
        ? { ...value, data: "" }
        : value;
    });
    bytes += Buffer.byteLength(wireText, "utf8");
    let text = "";
    let stepImages = 0;
    for (const block of step) {
      if (block.type === "text") text += block.text ?? "";
      else if (block.type === "resource" && block.resource) text += block.resource.text;
      else if (block.type === "image") stepImages++;
    }
    estimatedTokens += estimateTransferTokens(text, stepImages, Buffer.byteLength(text, "utf8"));
  }
  const budget = historyBudget(undefined, process.env, options.maxTransferBytes);
  if (bytes > budget) throw new Error(`Request payload too large (413): local ACP transfer needs ${bytes} bytes; budget is ${budget}. Use OMP /compact or raise maxTransferBytes. No history was silently truncated.`);
  if (estimatedTokens > options.inputTokenBudget) throw new Error(`Maximum context length exceeded: local ACP estimate is ${estimatedTokens} tokens; input budget is ${options.inputTokenBudget}. Use OMP /compact. This is a heuristic estimate, not a server token count. No history was silently truncated.`);
  const estimatedContextTokens = estimateContextTokens(context);
  return seedSteps?.length ? { prompt, seedSteps, messageCount: messages.length, estimatedContextTokens } : { prompt, messageCount: messages.length, estimatedContextTokens };
}
