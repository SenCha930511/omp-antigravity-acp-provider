import { test } from "node:test";
import assert from "node:assert/strict";
import { ACP_STEP_TEXT_BYTES, buildPromptParts, historyBudget, promptTextBytes, stableSystemInstructions } from "../extension/context-transfer.ts";
import { TOOL_ROUTING } from "../extension/tool-routing.ts";

const user = (content: any) => ({ role: "user", content, timestamp: 0 });
// The official ACP parser appends embedded-resource text to its result and
// merges subsequent text blocks into that string with a single space.
function parsedText(prompt: any[]) {
  const result: string[] = [];
  for (const block of prompt) {
    if (block.type === "resource") result.push(`Embedded resource (${block.resource.uri}):\n${block.resource.text}`);
    else if (block.type === "text") {
      if (result.length) result[result.length - 1] += " " + block.text;
      else result.push(block.text);
    }
  }
  return result.join("\n");
}
test("cold history and newest request remain explicitly separated after official ACP text merging", () => {
  const output = buildPromptParts({ messages: [user("OLD_REQUEST"),
    { role: "assistant", content: [{ type: "text", text: "OLD_ALREADY_ANSWERED" }] }, user("NEW_REQUEST")] }, true);
  const parsed = parsedText(output.prompt);
  assert.match(parsed, /Do not answer historical user requests/);
  assert.match(parsed, /# End of prior OMP conversation[\s\S]*\n\n# Current OMP user request\n\n[\s\S]*NEW_REQUEST$/);
  assert.equal(output.prompt.at(-1).text, "NEW_REQUEST");
});
test("cold handoff after a tool result explicitly resumes the active request instead of restarting it", () => {
  const output = buildPromptParts({ messages: [user("OLD_REQUEST"), user("ACTIVE_REQUEST"),
    { role: "assistant", content: [{ type: "toolCall", id: "call-active", name: "read", arguments: {} }] },
    { role: "toolResult", toolName: "read", toolCallId: "call-active", content: [{ type: "text", text: "ALREADY_READ" }] }] }, true);
  const parsed = parsedText(output.prompt);
  assert.match(parsed, /already in progress/);
  assert.match(parsed, /Continue from those results/);
  assert.ok(parsed.includes("call-active") && parsed.includes("ALREADY_READ"));
  assert.equal(output.prompt.at(-1).text, "ACTIVE_REQUEST");
});
test("tool results without any user record stay an explicit error", () => {
  assert.throws(() => buildPromptParts({ messages: [
    { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "read", arguments: {} }] },
    { role: "toolResult", toolName: "read", toolCallId: "call-1", content: [{ type: "text", text: "RESULT" }] },
  ] }, true), /No user message to send to Antigravity ACP/);
});
test("warm new user turn has an explicit current-request boundary without replaying old tasks", () => {
  const output = buildPromptParts({ messages: [user("OLD_REQUEST"),
    { role: "assistant", content: [{ type: "text", text: "DONE" }] }, user("NEW_REQUEST")] }, false, 2);
  const parsed = parsedText(output.prompt);
  assert.match(parsed, /# Current OMP user request\n\n[\s\S]*NEW_REQUEST$/);
  assert.ok(!parsed.includes("OLD_REQUEST"));
});
test("oversized historical text is split before the latest request can be truncated", () => {
  const messages = [user("PLAN_DOCKER_GATEWAY"),
    { role: "toolResult", toolName: "ask", toolCallId: "preferences", content: [{ type: "text", text: "User answers: Magpie; fixed upstream key; named tunnel" }] },
    { role: "toolResult", toolName: "read", toolCallId: "source", content: [{ type: "text", text: "source ".repeat(100_000) }] },
    { role: "assistant", content: [{ type: "text", text: "PLAN_COMPLETE" }] },
    user("EXPLAIN_THE_APPROVED_ARCHITECTURE")];
  const output = buildPromptParts({ messages }, true, undefined, { contextWindow: 1_000_000 });
  assert.ok(output.seedSteps?.length);
  for (const step of [...output.seedSteps, output.prompt]) {
    assert.ok(promptTextBytes(step) <= ACP_STEP_TEXT_BYTES);
  }
  const serialized = JSON.stringify([...output.seedSteps, output.prompt]);
  assert.match(serialized, /PLAN_DOCKER_GATEWAY/);
  assert.match(serialized, /PLAN_COMPLETE/);
  assert.match(JSON.stringify(output.prompt), /EXPLAIN_THE_APPROVED_ARCHITECTURE/);
});
test("single oversized UTF-8 current request splits into bounded steps instead of failing", () => {
  const output = buildPromptParts({ messages: [user("中".repeat(64_000))] }, true, undefined,
    { contextWindow: 1_000_000, policy: { maxTransferBytes: 134_217_728 } });
  assert.ok(output.seedSteps?.length, "expected the oversized current request to be split");
  for (const step of [...output.seedSteps, output.prompt]) {
    assert.ok(promptTextBytes(step) <= ACP_STEP_TEXT_BYTES);
  }
});
test("single oversized warm deltas split into bounded steps instead of failing", () => {
  const output = buildPromptParts({ messages: [user("OLD"), user("x".repeat(200_000))] }, false, 1,
    { contextWindow: 1_000_000 });
  assert.ok(output.seedSteps?.length, "expected the oversized warm delta to be split");
  for (const step of [...output.seedSteps, output.prompt]) {
    assert.ok(promptTextBytes(step) <= ACP_STEP_TEXT_BYTES);
  }
});
test("single-step sizing includes embedded-resource labels and reserves room for official metadata", () => {
  const prompt = [{ type: "resource", resource: { uri: "urn:fixture", mimeType: "text/plain", text: "中文" } },
    { type: "text", text: "NEXT" }];
  assert.ok(promptTextBytes(prompt) >= Buffer.byteLength(parsedText(prompt), "utf8"));
  assert.ok(ACP_STEP_TEXT_BYTES <= 192_000 - 4000);
  const context = { messages: [user("x".repeat(ACP_STEP_TEXT_BYTES - 1000))] };
  assert.equal(buildPromptParts(context, true, undefined, { contextWindow: 1_000_000 }).seedSteps, undefined);
  const oversized = buildPromptParts({ messages: [user("x".repeat(ACP_STEP_TEXT_BYTES))] }, true, undefined,
    { contextWindow: 1_000_000 });
  assert.ok(oversized.seedSteps?.length);
  for (const step of [...oversized.seedSteps, oversized.prompt]) {
    assert.ok(promptTextBytes(step) <= ACP_STEP_TEXT_BYTES);
  }
});

test("instructions too large for a seed acknowledgement stay in the final prompt", () => {
  const policy = "POLICY_MARKER_" + "P".repeat(187_700);
  const output = buildPromptParts({ systemPrompt: policy, messages: [
    user("OLD_" + "x".repeat(70_000)),
    { role: "assistant", content: [{ type: "text", text: "ANSWER" }] },
    user("LATEST"),
  ] }, true, undefined, { contextWindow: 1_000_000 });
  assert.ok(output.seedSteps?.length);
  assert.match(JSON.stringify(output.prompt), /POLICY_MARKER_/);
  assert.doesNotMatch(JSON.stringify(output.seedSteps), /POLICY_MARKER_/);
  for (const step of [...output.seedSteps, output.prompt]) {
    assert.ok(promptTextBytes(step) <= ACP_STEP_TEXT_BYTES);
  }
});
test("binary image payloads keep their independent budget instead of counting as rendered text", () => {
  const output = buildPromptParts({ messages: [user([{ type: "image", data: "a".repeat(300_000), mimeType: "image/png" },
    { type: "text", text: "DESCRIBE_IMAGE" }])] }, true, undefined, { contextWindow: 1_000_000 });
  assert.ok(promptTextBytes(output.prompt) < 1000);
  assert.equal(output.prompt.find(block => block.type === "image")?.data?.length, 300_000);
});
test("cold transfer retains old text beyond the former 32000-character cutoff", () => {
  const context = { systemPrompt: "RULES", messages: [user("EARLY_MARKER" + "x".repeat(80_000)), user("LATEST")] };
  const output = buildPromptParts(context, true, undefined, { contextWindow: 1_000_000 });
  const encoded = JSON.stringify(output.prompt);
  assert.ok(encoded.includes("EARLY_MARKER"));
  assert.ok(encoded.includes("RULES"));
  assert.equal(output.prompt.at(-1).text, "LATEST");
});
test("overflow fails explicitly instead of silently losing history or tool results", () => {
  assert.throws(() => buildPromptParts({ messages: [user("x".repeat(1_500_000)), user("LATEST")] }, true, undefined, { contextWindow: 1_000_000, policy: { inputTokenBudget: 400_000 } }), /Maximum context length exceeded/);
});
test("warm delta sends only external results and retains tool identities", () => {
  const messages = [user("OLD"), user("CURRENT"), { role: "toolResult", toolName: "read", toolCallId: "call-42", content: [{ type: "text", text: "RESULT" }] }];
  const output = buildPromptParts({ messages }, false, 2, { contextWindow: 1_000_000 });
  const text = JSON.stringify(output.prompt);
  assert.ok(text.includes("RESULT")); assert.ok(text.includes("call-42"));
  assert.ok(!text.includes('"OLD"')); assert.ok(!text.includes('"CURRENT"'));
  assert.equal(output.messageCount, 3);
});
test("historical images remain actual attachments; thinking is not replayed as text", () => {
  const image = { type: "image", data: "aW1hZ2U=", mimeType: "image/png" };
  const messages = [user([image]), { role: "assistant", content: [{ type: "thinking", thinking: "PRIVATE" }, { type: "text", text: "ANSWER" }] }, user("NEXT")];
  const output = buildPromptParts({ messages }, true, undefined, { contextWindow: 1_000_000 });
  assert.deepEqual(output.prompt.find(x => x.type === "image"), image);
  assert.ok(!JSON.stringify(output).includes("PRIVATE"));
});
test("wire budgets remain independent and oversized history splits instead of bypassing the single-step limit", () => {
  assert.equal(historyBudget(1_000_000, {}), 16_777_216);
  assert.equal(historyBudget(32_768, {}), 16_777_216);
  assert.equal(historyBudget(1_000_000, { OMP_ACP_HISTORY_BYTES: "33554432" }), 33_554_432);
  assert.throws(() => historyBudget(1_000_000, { OMP_ACP_HISTORY_BYTES: "NaN" }), /must be/);
  const output = buildPromptParts({ messages: [user("HISTORY_" + "x".repeat(1_200_000)), user("LATEST")] },
    true, undefined, { contextWindow: 1_000_000 });
  assert.ok(output.seedSteps?.length);
  for (const step of [...output.seedSteps, output.prompt]) {
    assert.ok(promptTextBytes(step) <= ACP_STEP_TEXT_BYTES);
  }
  assert.match(JSON.stringify([...output.seedSteps, output.prompt]), /HISTORY_/);
});

test("oversized non-text history stops serialization before inspecting later tool payloads", () => {
  let inspected = false;
  const messages = [user("OLD"),
    { role: "assistant", content: [{ type: "toolCall", id: "huge", name: "read", arguments: {
      text: "x".repeat(200_000),
    } }] },
    { role: "assistant", content: [{ type: "toolCall", id: "later", name: "read", arguments: {
      toJSON() { inspected = true; throw new Error("Later payload must not be inspected"); },
    } }] }, user("LATEST")];
  assert.throws(() => buildPromptParts({ messages }, true, undefined, { contextWindow: 1_000_000 }), /single-step/);
  assert.equal(inspected, false);
});

test("many content blocks receive the size error instead of overflowing the call stack", () => {
  const content = Array.from({ length: 150_000 }, () => ({ type: "text", text: "" }));
  assert.throws(() => buildPromptParts({ messages: [user(content)] }, true, undefined,
    { contextWindow: 1_000_000 }), /single-step/);
});

test("wire budget counts escaped embedded history and resource envelopes", () => {
  const messages = [user('"'.repeat(19_000)), user("LATEST")];
  const large = buildPromptParts({ messages }, true, undefined, { contextWindow: 1_000_000 });
  assert.ok(Buffer.byteLength(JSON.stringify(large.prompt), "utf8") > 65536);
  assert.throws(() => buildPromptParts({ messages }, true, undefined,
    { contextWindow: 1_000_000, policy: { maxTransferBytes: 65536 } }), /transfer needs/);
});

test("multi-message cold history exceeding single-step limit splits into sequential seedSteps instead of failing", () => {
  const chunkA = "CHUNK_A_" + "a".repeat(70_000);
  const chunkB = "CHUNK_B_" + "b".repeat(70_000);
  const chunkC = "CHUNK_C_" + "c".repeat(70_000);
  const messages = [
    user(chunkA),
    { role: "assistant", content: [{ type: "text", text: chunkB }] },
    { role: "toolResult", toolName: "read", toolCallId: "call-1", isError: false, content: [{ type: "text", text: chunkC }] },
    user("FINAL_QUESTION"),
  ];
  const output = buildPromptParts({ systemPrompt: `CUSTOM_POLICY\n\n${TOOL_ROUTING}`, messages }, true, undefined,
    { contextWindow: 1_000_000, sessionRouting: true });
  assert.ok(output.seedSteps && output.seedSteps.length >= 1, "expected multi-step seedSteps");
  for (const step of [...output.seedSteps, output.prompt]) {
    assert.ok(promptTextBytes(step) <= ACP_STEP_TEXT_BYTES);
  }
  const allSerialized = JSON.stringify([...output.seedSteps, output.prompt]);
  assert.ok(allSerialized.includes("CHUNK_A_"));
  assert.ok(allSerialized.includes("CHUNK_B_"));
  assert.ok(allSerialized.includes("CHUNK_C_"));
  assert.ok(allSerialized.includes("CUSTOM_POLICY"));
  assert.ok(!allSerialized.includes("Supplied OMP tools"), "sessionRouting deduplicates TOOL_ROUTING from instructions resource");
  assert.ok(!allSerialized.includes('"isError":false'), "isError: false is omitted in compact history serialization");
  assert.equal(output.prompt.at(-1)?.text, "FINAL_QUESTION");
});

test("single oversized current request splits into seed steps and a final request part", () => {
  const text = "CURRENT_START_" + "x".repeat(220_000) + "_CURRENT_END";
  const output = buildPromptParts({ messages: [user(text)] }, true, undefined,
    { contextWindow: 1_000_000 });
  assert.ok(output.seedSteps?.length, "expected the current request to be split");
  const steps = [...output.seedSteps, output.prompt];
  for (const step of steps) assert.ok(promptTextBytes(step) <= ACP_STEP_TEXT_BYTES);
  const allSerialized = JSON.stringify(steps);
  assert.match(allSerialized, /Current OMP user request \(part; not yet actionable\)/);
  assert.match(allSerialized, /Reply only with: OK/);
  assert.match(JSON.stringify(output.prompt), /Current OMP user request \(final part\)/);
  assert.match(JSON.stringify(output.prompt), /_CURRENT_END/);
  assert.match(allSerialized, /CURRENT_START_/);
});

test("single oversized request chunks preserve UTF-8 text without replacement characters", () => {
  const text = "中".repeat(70_000);
  const output = buildPromptParts({ messages: [user(text)] }, true, undefined,
    { contextWindow: 1_000_000 });
  assert.ok(output.seedSteps?.length, "expected the current request to be split");
  const textParts = [...output.seedSteps, output.prompt]
    .flat()
    .filter(block => block.type === "text")
    .map(block => block.text ?? "")
    .join("");
  assert.ok(!textParts.includes("\uFFFD"));
  assert.equal((textParts.match(/中/g) ?? []).length, 70_000);
});

test("oversized current request keeps attached images in exactly one step", () => {
  const image = { type: "image", data: "a".repeat(300_000), mimeType: "image/png" };
  const output = buildPromptParts({ messages: [user([image, {
    type: "text", text: "IMAGE_REQUEST_" + "x".repeat(220_000),
  }])] }, true, undefined, { contextWindow: 1_000_000 });
  assert.ok(output.seedSteps?.length, "expected the current request to be split");
  const steps = [...output.seedSteps, output.prompt];
  assert.equal(steps.flat().filter(block => block.type === "image").length, 1);
  for (const step of steps) assert.ok(promptTextBytes(step) <= ACP_STEP_TEXT_BYTES);
});

test("oversized historical image-bearing text splits without losing the image", () => {
  const image = { type: "image", data: "a".repeat(1_000), mimeType: "image/png" };
  const messages = [
    user([{ type: "text", text: "OLD_IMAGE_" + "x".repeat(200_000) }, image]),
    { role: "assistant", content: [{ type: "text", text: "ANSWER" }] },
    user("LATEST"),
  ];
  const output = buildPromptParts({ messages }, true, undefined, { contextWindow: 1_000_000 });
  assert.ok(output.seedSteps?.length, "expected the historical record to be split");
  const steps = [...output.seedSteps, output.prompt];
  assert.equal(steps.flat().filter(block => block.type === "image").length, 1);
  for (const step of steps) assert.ok(promptTextBytes(step) <= ACP_STEP_TEXT_BYTES);
  assert.match(JSON.stringify(output.prompt), /LATEST/);
});

test("seed steps renumber historical image attachments against each step's image list", () => {
  const imageA = { type: "image", data: "aW1hZ2UtYQ==", mimeType: "image/png" };
  const imageB = { type: "image", data: "aW1hZ2UtYg==", mimeType: "image/jpeg" };
  const messages = [
    user([{ type: "text", text: "IMAGE_A_" + "a".repeat(100_000) }, imageA]),
    { role: "assistant", content: [{ type: "text", text: "MIDDLE_" + "b".repeat(100_000) }] },
    user([imageB, { type: "text", text: "IMAGE_B_" + "c".repeat(100_000) }]),
    user("FINAL_IMAGE_QUESTION"),
  ];
  const output = buildPromptParts({ messages }, true, undefined, { contextWindow: 1_000_000 });
  assert.ok(output.seedSteps?.length, "expected the history to be split into seed steps");
  const steps = [...output.seedSteps, output.prompt];
  for (const step of steps) {
    const history = step.find(block => block.type === "resource" && block.resource?.uri.endsWith(":history"));
    assert.ok(history?.resource, "each seed/final step with history needs a history resource");
    const imageCount = step.filter(block => block.type === "image").length;
    const attachments = [...history.resource.text.matchAll(/"attachment":(\d+)/g)].map(match => Number(match[1]));
    assert.ok(attachments.every(index => Number.isInteger(index) && index >= 0 && index < imageCount),
      `step-local attachment ${attachments.join(",")} must reference one of ${imageCount} image blocks`);
  }
  assert.equal(steps.flatMap(step => step).filter(block => block.type === "image").length, 2);
});

test("stableSystemInstructions ignores volatile reminders and tool lists but preserves routing policy", () => {
  const base = stableSystemInstructions({ systemPrompt: "CORE_POLICY", messages: [] });
  const decorated = stableSystemInstructions({
    systemPrompt: `CORE_POLICY\n\n<system-reminder>\nToday: 2026-11-07\n</system-reminder>\n\n${TOOL_ROUTING}\nOMP tool names: pi_read, pi_write`,
    messages: [],
  });
  assert.notEqual(decorated, base);
  const legacy = buildPromptParts({ systemPrompt: `CORE_POLICY\n\n${TOOL_ROUTING}`,
    messages: [user("LATEST")] }, true, undefined, { contextWindow: 1_000_000 });
  assert.match(JSON.stringify(legacy.prompt), /Supplied OMP tools/);
  assert.match(decorated, /Supplied OMP tools/);
  const volatile = stableSystemInstructions({
    systemPrompt: "CORE_POLICY\n\n<system-reminder>\nToday: 2026-11-07\n</system-reminder>\n\nOMP tool names: pi_read, pi_write",
    messages: [],
  });
  assert.equal(volatile, base);
  const policy = stableSystemInstructions({
    systemPrompt: "CORE_POLICY\n\n<system-reminder>NEW_SECURITY_POLICY</system-reminder>",
    messages: [],
  });
  assert.notEqual(policy, base);
  assert.match(policy, /NEW_SECURITY_POLICY/);
});
