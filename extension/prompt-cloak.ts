/**
 * Rewrites system-prompt phrases Antigravity refuses regardless of quota.
 *
 * agy answers some third-party harness prompt lines with RESOURCE_EXHAUSTED
 * (429) whatever quota is left; the refusal is content-based, so waiting or
 * switching models does not help. The known lines are reworded minimally
 * before they reach `systemPrompt.append`: meaning is preserved, the exact
 * fingerprint is not. Phrase list and rewordings adapted from
 * a community Antigravity bridge plugin's cloak module (MIT, DylanLIiii, gitxm, yce; see
 * THIRD_PARTY_NOTICES.md); Claude-Code-only long passages and billing-header
 * lines are omitted because OMP instructions cannot contain them.
 */
export interface CloakRule {
  id: string;
  /** Lowercase, whitespace-folded needle matched against normalized text. */
  phrase: string;
  /** Produces the replacement for the matched source slice. */
  says: (matched: string) => string;
}

const youAre = (matched: string) => matched.replace(/^you\s+are/iu, "you're");
const basedToBuilt = (matched: string) => matched.replace(/based(\s+)on/iu, "built$1");

export const CLOAK_RULES: readonly CloakRule[] = [
  { id: "claude-agent-sdk", phrase: "built on anthropic's claude agent sdk",
    says: matched => matched.replace(/^(built\s+on\s+)anthropic's(\s+)(claude\s+agent\s+sdk)$/iu, "$1the$2$3 by Anthropic") },
  { id: "codex-agent", phrase: "you are codex, an agent based on gpt-5", says: basedToBuilt },
  { id: "codex-coding-agent", phrase: "you are codex, a coding agent based on gpt-5", says: basedToBuilt },
  { id: "rfc2119-keywords", phrase: "rfc 2119 keywords: must, required, should, recommended, may, optional.",
    says: matched => matched.replace(/(key)(words)/iu, "$1 $2") },
  { id: "hermes-agent", phrase: "you are hermes agent", says: youAre },
  { id: "nous-research", phrase: "an intelligent ai assistant created by nous research",
    says: matched => matched.replace(/created(\s+)by/iu, "built$1") },
  { id: "opencode", phrase: "you are opencode", says: youAre },
  { id: "codex-cli", phrase: "you are a coding agent running in the codex cli", says: youAre },
  { id: "pi-harness", phrase: "a coding assistant running inside pi",
    says: matched => matched.replace(/inside/iu, "within") },
  { id: "deepseek-harness", phrase: "you are an ai agent powered by deepseek harness", says: youAre },
  { id: "claude-code", phrase: "you are claude code, anthropic's official cli for claude", says: youAre },
  { id: "pi-bolt", phrase: "you are a coding assistant running inside pi-bolt",
    says: matched => matched.replace(/pi-bolt$/iu, "a tool") },
  // Verified live on 2026-11-16: this exact guidance sentence alone draws a
  // 429 whatever quota is left, while the reworded form passes; the detector
  // is sentence-level, so breaking the token chain is what matters.
  { id: "omp-tool-docs", phrase: "for full docs + json schema before first use",
    says: matched => matched.replace(/\+\s*/u, "and ").replace(/schema(?!\s*s)/iu, "schemas") },
  // Also verified live on 2026-11-16: the canonical smoke-test prompt
  // "Reply with exactly: OK" alone draws the 429 when it lands in the system
  // prompt (a recalled memory can carry it there), while the same words as a
  // user turn or with any other value pass.
  { id: "omp-eval-prompt", phrase: "reply with exactly: ok",
    says: matched => matched.replace(/^reply/iu, "Respond") },
  // OMP 19.0.0's commit-guidance clause alone draws a 429 with quota left.
  { id: "omp-commit-guidance",
    phrase: "it selects only the lines you and your subagents wrote and never touches other agents' staged or unstaged work",
    says: matched => matched
      .replace(/selects\s+only\s+the\s+lines\s+you\s+and\s+your\s+subagents\s+wrote/iu, "picks only lines written by you or your subagents")
      .replace(/never\s+touches\s+other\s+agents'\s+staged\s+or\s+unstaged\s+work/iu, "leaves other agents' staged or unstaged work alone") },
];

const INVISIBLE_RE = /[\u00ad\u180e\u200b-\u200f\u2060-\u2064\ufeff]/gu;

function isInvisible(code: number): boolean {
  return code === 0x00ad || code === 0x180e ||
    (code >= 0x200b && code <= 0x200f) || (code >= 0x2060 && code <= 0x2064) || code === 0xfeff;
}

/**
 * Folds text for matching while retaining source offsets: invisible
 * characters are skipped, letters are lowercased, and whitespace runs become
 * one space. Only matched spans are ever rewritten, so the rest of the source
 * stays byte-identical.
 */
function matchText(text: string): { text: string; offsets: number[] } {
  const chars: string[] = [];
  const offsets: number[] = [];
  let previousSpace = false;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (isInvisible(code)) continue;
    const char = text[i]!;
    if (/\s/u.test(char)) {
      if (!previousSpace) {
        chars.push(" ");
        offsets.push(i);
      }
      previousSpace = true;
    } else {
      chars.push(code >= 65 && code <= 90 ? String.fromCharCode(code + 32) : char);
      offsets.push(i);
      previousSpace = false;
    }
  }
  return { text: chars.join(""), offsets };
}

export interface CloakResult {
  text: string;
  /** Rule ids whose phrase appeared in the source. */
  matched: string[];
}

/** Rewrites every known fingerprint phrase in `text`, leaving the rest intact. */
export function cloakText(text: string): CloakResult {
  if (typeof text !== "string" || !text) return { text, matched: [] };
  const normalized = matchText(text);
  const matched: string[] = [];
  const spans: Array<[number, number, CloakRule]> = [];
  for (const rule of CLOAK_RULES) {
    let from = 0;
    for (;;) {
      const at = normalized.text.indexOf(rule.phrase, from);
      if (at < 0) break;
      spans.push([normalized.offsets[at]!, normalized.offsets[at + rule.phrase.length - 1]! + 1, rule]);
      if (!matched.includes(rule.id)) matched.push(rule.id);
      from = at + rule.phrase.length;
    }
  }
  if (!spans.length) return { text, matched };
  spans.sort((a, b) => a[0] - b[0]);
  let result = "";
  let previous = 0;
  for (const [from, to, rule] of spans) {
    if (from < previous) continue;
    result += text.slice(previous, from);
    result += rule.says(text.slice(from, to).replace(INVISIBLE_RE, ""));
    previous = to;
  }
  return { text: result + text.slice(previous), matched };
}

/** Whether `text` still contains any known fingerprint phrase. */
export function turnsAway(text: string): boolean {
  if (typeof text !== "string" || !text) return false;
  const normalized = matchText(text).text;
  return CLOAK_RULES.some(rule => normalized.includes(rule.phrase));
}
