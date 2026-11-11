import fs from "node:fs";
import { writeJsonAtomic, isMissingFileError } from "./fs-atomic.ts";
export class Diagnostics {
  private enabled = false;
  private readonly samples: Array<{ stage: string; ms: number }> = [];
  constructor(private readonly file: string) {
    try { this.enabled = JSON.parse(fs.readFileSync(file, "utf8")).enabled === true; } catch (e) { if (!isMissingFileError(e)) this.enabled = false; }
  }
  configure(enabled: boolean) { writeJsonAtomic(this.file, { enabled }, false); this.enabled = enabled; if (!enabled) this.samples.length = 0; }
  reset() { this.samples.length = 0; }
  record(stage: string, ms: number) {
    if (!this.enabled || !Number.isFinite(ms) || ms < 0) return;
    this.samples.push({ stage, ms }); if (this.samples.length > 128) this.samples.shift();
  }
  sync<T>(stage: string, work: () => T): T { if (!this.enabled) return work(); const t = performance.now(); try { return work(); } finally { this.record(stage, performance.now() - t); } }
  async measure<T>(stage: string, work: () => Promise<T>): Promise<T> { if (!this.enabled) return work(); const t = performance.now(); try { return await work(); } finally { this.record(stage, performance.now() - t); } }
  status() {
    const groups = new Map<string, number[]>();
    for (const sample of this.samples) {
      let values = groups.get(sample.stage);
      if (!values) {
        values = [];
        groups.set(sample.stage, values);
      }
      values.push(sample.ms);
    }
    const stages: { [key: string]: { count: number; medianMs: number; maxMs: number } } = {};
    for (const [name, values] of groups) {
      values.sort((a, b) => a - b);
      stages[name] = { count: values.length, medianMs: +values[Math.floor(values.length / 2)].toFixed(3), maxMs: +values.at(-1)!.toFixed(3) };
    }
    return { enabled: this.enabled, samples: this.samples.length, capacity: 128, stages };
  }
}

// Instrument only adapter-controlled methods. No request content, model output,
// account identifiers or session IDs are collected or persisted.
export function instrumentRuntime(runtime: object, diagnostics: Diagnostics) {
  for (const [method, stage] of [["ompMessagesFingerprint", "history.compare"], ["ompToolsFingerprint", "tools.compare"]]) {
    const original = Reflect.get(runtime, method) as (...args: unknown[]) => unknown;
    Reflect.set(runtime, method, (...args: unknown[]) => diagnostics.sync(stage, () => original.apply(runtime, args)));
  }
  for (const [method, stage] of [["getBinding", "session.binding"], ["createBinding", "session.initialize-or-restore"], ["persistBinding", "checkpoint.write"]]) {
    const original = Reflect.get(runtime, method) as (...args: unknown[]) => Promise<unknown>;
    Reflect.set(runtime, method, (...args: unknown[]) => diagnostics.measure(stage, () => original.apply(runtime, args)));
  }
  const drop = Reflect.get(runtime, "dropBinding") as (...args: unknown[]) => Promise<unknown>;
  Reflect.set(runtime, "dropBinding", (...args: unknown[]) => diagnostics.measure(args[2] ? "session.rebuild" : "session.close", () => drop.apply(runtime, args)));
}
