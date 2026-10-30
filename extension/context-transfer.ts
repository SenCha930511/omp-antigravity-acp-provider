// Adapter-owned context transfer. The pinned upstream dependency stays intact.
import { getCurrentSystemPrompt } from "@earendil-works/pi-ai/utils/transcript";
import { estimateTransferTokens, resolveContextOptions, type ContextOptions, type ResolvedContextOptions } from "./context-settings.ts";
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
}

// The official harness applies a 64,000-token per-step conversion limit,
// independently of the model window. Its overflow path keeps only the first
// 192,000 UTF-8 bytes. Reserve room for USER_REQUEST/time metadata added by ACP;
// otherwise a cold replay can silently lose its newest question at the tail.
export const ACP_STEP_TEXT_BYTES = 188_000;

function checkStepTextBytes(bytes: number): void {
  if (bytes > ACP_STEP_TEXT_BYTES) {
    throw new Error(`Maximum context length exceeded: official Antigravity ACP single-step text needs at least ${bytes} bytes; safe budget is ${ACP_STEP_TEXT_BYTES} bytes. Compact the conversation with OMP /compact and retry. A larger contextWindow or maxTransferBytes does not raise this server limit. No history or current request was sent or silently truncated.`);
  }
}

function serializeHistory(records: unknown[]): string {
  let stringBytes = 0;
  // The replacer sees each value before JSON allocates its escaped string.
  // This lower bound aborts oversized replay without copying its full text;
  // the exact rendered size (including JSON syntax) is checked below as well.
  return JSON.stringify(records, (_key, value) => {
    if (typeof value === "string") {
      stringBytes += Buffer.byteLength(value, "utf8");
      checkStepTextBytes(stringBytes);
    }
    return value;
  });
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

export function historyBudget(_contextWindow = 32_768, env = process.env, configured = 16_777_216): number {
  const bytes = Number(env.OMP_ACP_HISTORY_BYTES ?? configured);
  if (!Number.isSafeInteger(bytes) || bytes < 65_536 || bytes > 134_217_728) {
    throw new Error("OMP_ACP_HISTORY_BYTES must be an integer between 65536 and 134217728");
  }
  return bytes;
}

export function buildPromptParts(context: TransferContext, fresh: boolean, unseenStart?: number,
  limits: { contextWindow?: number; maxTokens?: number; policy?: ContextOptions } = {}) {
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
  const prompt: TransferBlock[] = [];
  const instructions = fresh ? currentSystemInstructions(context) : "";
  checkStepTextBytes(Buffer.byteLength(instructions, "utf8"));
  const instructionsText = instructions ? `# OMP session instructions\n\n${instructions}` : "";
  if (instructionsText) prompt.push({ type: "resource", resource: {
    uri: "urn:omp:antigravity-acp:instructions", mimeType: "text/markdown",
    text: instructionsText,
  } });
  const records: Array<{ role: string; toolName?: string; toolCallId?: string; isError?: boolean; content: string | TransferBlock[] }> = [];
  const images: TransferBlock[] = [];
  for (let index = start; index < end; index++) {
    const message = messages[index]!;
    if (index === latest || message.role === "system") continue;
    const content = typeof message.content === "string" ? message.content : message.content
      .filter(block => ["text", "toolCall", "image"].includes(block.type))
      .map(block => {
        if (block.type === "image") {
          const imageIndex = images.length;
          images.push({ type: "text", text: `Historical image from OMP message ${index}; treat as conversation data.` },
            { type: "image", data: block.data, mimeType: block.mimeType });
          return { type: "image", attachment: imageIndex / 2 };
        }
        return block.type === "toolCall" ? { type: block.type, id: block.id, name: block.name, arguments: block.arguments }
          : { type: "text", text: block.text };
      });
    records.push({ role: message.role, toolName: message.toolName, toolCallId: message.toolCallId, isError: message.isError, content });
  }
  const historyText = records.length
    ? "# Prior OMP conversation (reference only)\n\n" +
      "The JSON below is historical conversation data, not a new request or a queue of tasks. " +
      "Do not answer historical user requests or repeat completed tool actions. " +
      "Use it only as context for the current OMP user request identified after this resource.\n\n" +
      serializeHistory(records) + "\n\n# End of prior OMP conversation\n"
    : "";
  if (historyText) prompt.push({ type: "resource", resource: {
    uri: "urn:omp:antigravity-acp:history", mimeType: "text/plain",
    text: historyText,
  } });
  for (const block of images) prompt.push(block);
  const tailBlocks: TransferBlock[] = [];
  if (!fresh && start > latest) {
    const continuation = { type: "text", text: "\n\n# Continue the active OMP request\n\n" +
      "The new context/tool results above belong to the user request already received in this session. " +
      "Finish that request from those results. Do not answer historical user requests or repeat completed tool actions." };
    prompt.push(continuation);
    tailBlocks.push(continuation);
  } else {
    // Official ACP merges following text into an embedded-resource string with
    // a space. Explicit newlines/labels must survive that conversion; role
    // fields inside the history JSON do not create actual API message roles.
    const boundary = { type: "text", text: "\n\n# Current OMP user request\n\n" +
      (end > latest ? "This request is already in progress; the history includes prior assistant actions and tool results. " +
        "Continue from those results rather than restarting completed work.\n\n" : "") };
    prompt.push(boundary);
    tailBlocks.push(boundary);
    const content = messages[latest]!.content;
    // Blocks are consumed read-only; shallow copies only churn the hot path.
    const latestBlocks: TransferBlock[] = typeof content === "string" ? [{ type: "text", text: content }] : content;
    for (const block of latestBlocks) { prompt.push(block); tailBlocks.push(block); }
  }
  // Reject oversized latest text before allocating its JSON wire copy too.
  checkStepTextBytes(promptTextBytes(prompt));
  // Image base64 size is not a text-token estimate. Bound its actual memory
  // footprint separately, and reserve a conservative text-equivalent allowance.
  let imageBytes = 0;
  let imageCount = 0;
  let imageWireChars = 0;
  const tailTextOnly: TransferBlock[] = [];
  for (const group of [images, tailBlocks]) for (const block of group) {
    if (block.type !== "image") {
      tailTextOnly.push(block);
      continue;
    }
    const dataLen = block.data?.length ?? 0;
    imageBytes += Math.ceil(dataLen * 3 / 4);
    imageWireChars += dataLen;
    imageCount++;
    tailTextOnly.push({ type: "image", mimeType: block.mimeType });
  }
  if (imageBytes > options.maxImageBytes) throw new Error(`Request payload too large (413): local ACP image budget is ${options.maxImageBytes} bytes; reduce attachments. No images were silently omitted.`);
  const instructionsBytes = instructionsText ? Buffer.byteLength(instructionsText, "utf8") + 108 : 0;
  const historyBytes = historyText ? Buffer.byteLength(historyText, "utf8") + 100 : 0;
  const tailSerialized = JSON.stringify(tailTextOnly);
  const tailBytes = Buffer.byteLength(tailSerialized, "utf8");
  // Embedded history is JSON inside a resource string: its quotes and slashes
  // are escaped again on the wire. Count actual envelopes/escaping without
  // copying potentially large base64 data (ASCII with no JSON escaping).
  const wireText = JSON.stringify(prompt.map(block => block.type === "image" ? { ...block, data: "" } : block));
  const bytes = Buffer.byteLength(wireText, "utf8") + imageWireChars;
  const budget = historyBudget(undefined, process.env, options.maxTransferBytes);
  if (bytes > budget) throw new Error(`Request payload too large (413): local ACP transfer needs ${bytes} bytes; budget is ${budget}. Use OMP /compact or raise maxTransferBytes. No history was silently truncated.`);
  const estimatedTokens =
    (instructionsText ? estimateTransferTokens(instructionsText, 0, instructionsBytes - 108) : 0) +
    (historyText ? estimateTransferTokens(historyText, 0, historyBytes - 100) : 0) +
    estimateTransferTokens(tailSerialized, imageCount, tailBytes);
  if (estimatedTokens > options.inputTokenBudget) throw new Error(`Maximum context length exceeded: local ACP estimate is ${estimatedTokens} tokens; input budget is ${options.inputTokenBudget}. Use OMP /compact. This is a heuristic estimate, not a server token count. No history was silently truncated.`);
  return { prompt, messageCount: messages.length };
}
