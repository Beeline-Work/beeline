import type { LaneBatch, LaneFact } from './read-lanes.js';
import { jsonBytes, stagingWithinBudget } from './staging-bounds.js';

type Record = { header: Omit<LaneBatch, 'facts'>; bytes: number; order:number };
type Reference = { record: Record; facts: readonly LaneFact[] };
export type StagedInterval = { batch: LaneBatch; bytes: number };
export const intervalId = (batch: LaneBatch): string => JSON.stringify([
  batch.to.stream, batch.to.epoch, batch.to.protocol, batch.from.through, batch.to.through,
]);
const equal = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
export const sameStream=(a:LaneBatch['to'],b:LaneBatch['to']):boolean=>a.stream===b.stream&&a.epoch===b.epoch&&a.protocol===b.protocol;

/** Retained logical intervals have one envelope and one byte charge per stream,
 * even when several opening lanes/windows need different facts from them.
 * Only the same owned decoded body shares a charge: legacy independent
 * deliveries can have the same cut without being the same logical body.
 * References keep the original fact objects, never another private body copy.
 * This is staging inside ReadLanes' serial owner, not another state executor. */
export class LaneStaging {
  private readonly sources = new WeakMap<LaneBatch,Record>();
  private order=0;
  private readonly stages = new Set<IntervalStage>();
  stage(future = false): IntervalStage { return new IntervalStage(this, future); }
  attach(stage: IntervalStage, batch: LaneBatch, facts: readonly LaneFact[], size: number): Reference {
    const { facts: _facts, ...header } = batch;
    let record = this.sources.get(batch);
    if (record && !equal(record.header, header)) throw new Error('Conflicting projection interval');
    const previous = record?.bytes;
    if (!record) this.sources.set(batch, record = { header, bytes: size,order:0 });
    else record.bytes = Math.max(record.bytes, size);
    // Check original logical bytes, never the smaller selected fact subset.
    const held=new Set<Record>();
    for(const owner of this.stages)for(const value of owner.records())if(value.header.to.stream===batch.to.stream)held.add(value);
    // Iterating consumers is not source arrival order. A reattached released
    // body is a new arrival; the oldest still-held source remains primary.
    if(!held.has(record))record.order=this.order++;
    held.add(record);
    if (!stagingWithinBudget(held, item => item.bytes,item=>item.order)) {
      if (previous !== undefined) record.bytes = previous;
      throw new Error('Projection staging overflow');
    }
    this.stages.add(stage);
    return { record, facts };
  }
  release(stage: IntervalStage): void { if (!stage.size) this.stages.delete(stage); }
  /** Floors/denials must release private references held on behalf of other
   * consumers too. Content-free controls can still prove ordered continuity. */
  prune(keep: (fact: LaneFact) => boolean): void {
    for (const stage of this.stages) stage.prune(keep);
  }
}

export class IntervalStage implements Iterable<[string, StagedInterval]> {
  private readonly refs = new Map<string, Reference>();
  constructor(private readonly store: LaneStaging, private readonly future: boolean) {}
  get size(): number { return this.refs.size; }
  *records():IterableIterator<Record>{for(const ref of this.refs.values())yield ref.record;}
  get(id: string): StagedInterval | undefined {
    const ref = this.refs.get(id);
    return ref && { batch: { ...ref.record.header, facts: ref.facts }, bytes: ref.record.bytes };
  }
  *[Symbol.iterator](): IterableIterator<[string, StagedInterval]> {
    for (const id of this.refs.keys()) yield [id, this.get(id)!];
  }
  *values(): IterableIterator<StagedInterval> { for (const [, value] of this) yield value; }
  add(batch: LaneBatch, facts: readonly LaneFact[] = batch.facts, size = jsonBytes(batch),future=this.future): void {
    const id = intervalId(batch), prior = this.refs.get(id), { facts: _facts, ...header } = batch;
    if (prior) {
      if (!equal(prior.record.header, header) || !equal(prior.facts, facts)) throw new Error('Conflicting projection interval');
      return;
    }
    if (future && (this.size >= 16 || [...this.values()].reduce((sum, item) => sum + item.bytes, size) > 256 * 1024))
      throw new Error('Projection gap overflow');
    const ref = this.store.attach(this, batch, facts, size);
    this.refs.set(id, ref);
  }
  delete(id: string): void {
    const ref = this.refs.get(id); if (!ref) return;
    this.refs.delete(id); this.store.release(this);
  }
  clear(): void { for (const id of this.refs.keys()) this.delete(id); }
  take(): LaneBatch[] { const batches = [...this.values()].map(value => value.batch); this.clear(); return batches; }
  prune(keep: (fact: LaneFact) => boolean): void {
    for (const ref of this.refs.values()) ref.facts = ref.facts.filter(keep);
  }
}
