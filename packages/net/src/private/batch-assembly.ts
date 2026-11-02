import type { LaneBatch, LaneCut, LaneFact } from './read-lanes.js';
export type RouterPart = Readonly<{ kind: 'push-part'; batchId: string; from: LaneCut; to: LaneCut;
  partIndex: number; partCount: number; contentDigest: string; facts: readonly LaneFact[] }>;
export type RouterCommit = Readonly<{ kind: 'push-commit'; batchId: string; from: LaneCut; to: LaneCut;
  partCount: number; contentDigest: string }>;
type Batch = { identity: string; parts: Map<number, RouterPart>; bytes: number; commit?: RouterCommit };
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;
const identity = (frame: RouterPart | RouterCommit) => JSON.stringify([
  frame.batchId, frame.from, frame.to, frame.partCount, frame.contentDigest,
]);

/** Bounded staging. Neither a part nor a commit alone can advance a cut.
 * Digest is injected by the trusted platform adapter; this module imports no SDK.
 */
export class RouterBatchAssembly {
  private readonly streams = new Map<string, Map<string, Batch>>();
  private readonly completed = new Map<string, string>();
  constructor(private readonly digest: (facts: readonly LaneFact[]) => string,
    private readonly commit: (batch: LaneBatch) => void,
    private readonly fault: (stream: string) => void) {}

  accept(frame: RouterPart | RouterCommit): void {
    const stream = frame.to.stream;
    const invalid = !frame.batchId || frame.batchId.length > 128 || !frame.contentDigest ||
      frame.contentDigest.length > 128 || frame.from.stream !== stream || frame.from.epoch !== frame.to.epoch ||
      frame.from.protocol !== 1 || frame.to.protocol !== 1 || !Number.isSafeInteger(frame.from.through) ||
      !Number.isSafeInteger(frame.to.through) || frame.from.through < 0 || frame.to.through < frame.from.through ||
      !Number.isInteger(frame.partCount) || frame.partCount < 1 || frame.partCount > 16 ||
      bytes(frame) > 256 * 1024;
    if (invalid) { this.fail(stream); return; }
    const signature = identity(frame);
    const completed = this.completed.get(`${stream}\0${frame.batchId}`);
    if (completed) { if (completed !== signature) this.fail(stream); return; }
    let batches = this.streams.get(stream);
    if (!batches) { batches = new Map(); this.streams.set(stream, batches); }
    let batch = batches.get(frame.batchId);
    if (!batch) {
      if (batches.size >= 17) { this.fail(stream); return; }
      batch = { identity: signature, parts: new Map(), bytes: 0 }; batches.set(frame.batchId, batch);
    }
    if (batch.identity !== signature) { this.fail(stream); return; }
    if (frame.kind === 'push-commit') batch.commit = frame;
    else {
      if (!Number.isInteger(frame.partIndex) || frame.partIndex < 0 || frame.partIndex >= frame.partCount ||
          bytes(frame.facts) > 64 * 1024) { this.fail(stream); return; }
      const held = batch.parts.get(frame.partIndex);
      if (held && JSON.stringify(held) !== JSON.stringify(frame)) { this.fail(stream); return; }
      if (!held) { batch.parts.set(frame.partIndex, frame); batch.bytes += bytes(frame.facts); }
      if (batch.bytes > 1024 * 1024) { this.fail(stream); return; }
    }
    const total = [...batches.values()].reduce((size, value) => size + value.bytes, 0);
    // One logical batch (1 MiB), plus bounded future staging (256 KiB).
    const primary = batches.values().next().value!;
    if (total > 1280 * 1024 || total - primary.bytes > 256 * 1024) { this.fail(stream); return; }
    if (!batch.commit || batch.parts.size !== frame.partCount) return;
    const facts: LaneFact[] = [];
    for (let index = 0; index < frame.partCount; index++) {
      const part = batch.parts.get(index);
      if (!part) return;
      facts.push(...part.facts);
    }
    const authorities = new Set(facts.flatMap(fact => fact.authority.scopes.map(scope => `${scope.authorityScope}\0${scope.epoch}`)));
    if (authorities.size > 256) { this.fail(stream); return; }
    if (this.digest(facts) !== frame.contentDigest) { this.fail(stream); return; }
    batches.delete(frame.batchId);
    if (!batches.size) this.streams.delete(stream);
    this.completed.set(`${stream}\0${frame.batchId}`, signature);
    while (this.completed.size > 128) this.completed.delete(this.completed.keys().next().value!);
    this.commit({ from: frame.from, to: frame.to, facts });
  }
  reset(): void { this.streams.clear(); this.completed.clear(); }
  private fail(stream: string): void { this.streams.delete(stream); this.fault(stream); }
}
