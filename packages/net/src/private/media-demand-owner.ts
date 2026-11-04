import { AdmissionOwner, type MediaAction } from './admission.js';
type MediaOperation = 'readMediaMetadata' | 'readMediaLink' | 'readMediaPlayback';
type Focus = Readonly<{ screen: string; generation: number; roomId?: string }>;
type Permit = { wire: Readonly<{ operation: string; input: string }>; isCurrent(): boolean };
/** Private navigation/gesture bridge. Feature code sees closed existing actions,
 * never passes, route names, keys, generations or caller-controlled bypass flags.
 */
export class MediaDemandOwner {
  private connection?: object;
  private focus?: Focus;
  private residency?: Focus;
  private lastConnection = -1;
  private visible = new Set<string>();
  private readonly known = new Map<string, boolean>();
  private readonly pending = new Map<string, Permit>();
  private active = 0;
  private readonly sleepers = new Set<() => void>();
  private readonly waiting: Array<() => void> = [];
  constructor(private readonly admission: AdmissionOwner, private readonly current: () => Focus | null,
    private readonly invalidated: () => void = () => {}, private readonly displays: () => readonly string[] = () => []) {}
  connected(generation: number): void {
    if (!Number.isSafeInteger(generation) || generation < 0 || generation <= this.lastConnection) return;
    this.lastConnection = generation; this.connection = {}; this.pending.clear(); this.navigationChanged();
    const focus = this.focus;
    if (focus?.screen !== 'Room' || !focus.roomId) return;
    // Recover current displays; historical demand is evictable metadata.
    const ids = new Set([...this.visible, ...this.displays().filter(id => this.known.has(id))]);
    const requests = [...ids].flatMap(objectId => [
      { route: 'phone.readMediaMetadata' as const, input: { objectId } },
      ...(this.known.get(objectId) ? [{ route: 'phone.readMediaPlayback' as const, input: { objectId } }] : []),
    ]);
    const passes = this.admission.mediaRecovery(generation, focus.generation, focus.roomId, requests);
    requests.forEach((request, index) => this.keep(request.route === 'phone.readMediaPlayback' ? 'readMediaPlayback' : 'readMediaMetadata',
      request.input.objectId, this.admission.spend(request, passes[index]!), focus, this.connection!, true));
  }
  disconnected(): void { this.wake(); this.connection = undefined; this.pending.clear(); this.admission.clearMediaFocus(); }
  navigationChanged(): void {
    const next = this.current();
    if (next && (next.screen !== 'Room' || next.generation !== this.residency?.generation || next.roomId !== this.residency?.roomId)) {
      this.known.clear(); this.visible.clear(); this.residency = next;
    }
    if (next?.generation !== this.focus?.generation || next?.roomId !== this.focus?.roomId || next?.screen !== this.focus?.screen) {
      this.wake(); this.pending.clear(); this.admission.clearMediaFocus(); this.focus = next ?? undefined; this.invalidated();
    }
    if (this.connection && next?.screen === 'Room' && next.roomId) this.admission.mediaFocus(next.generation, next.roomId);
  }
  viewport(roomId: string, objectIds: readonly string[]): void {
    this.navigationChanged(); const focus = this.focus;
    if (focus?.screen !== 'Room' || focus.roomId !== roomId) return;
    this.visible = new Set(objectIds);
    for (const key of this.pending.keys()) {
      const [, id] = JSON.parse(key) as [string, string];
      if (!this.visible.has(id) && !this.displays().includes(id)) this.pending.delete(key);
    }
    for (const id of this.visible) this.remember(id, false);
    if (!this.connection) return;
    for (const { objectId, pass } of this.admission.mediaVisible(focus.generation, roomId, objectIds)) {
      const request = { route: 'phone.readMediaMetadata' as const, input: { objectId } };
      this.keep('readMediaMetadata', objectId, this.admission.spend(request, pass), focus, this.connection);
    }
  }
  action(action: MediaAction, objectId: string): void {
    this.navigationChanged(); const focus = this.focus;
    if (focus?.screen !== 'Room' || !focus.roomId) { if (!this.connection) return; throw new Error('File action is not focused.'); }
    this.remember(objectId, action === 'RunArtifact');
    if (!this.connection) return;
    const operation: MediaOperation = action === 'OpenArtifactBrowser' ? 'readMediaLink' : action === 'RunArtifact'
      ? 'readMediaPlayback' : 'readMediaMetadata';
    const request = { route: `phone.${operation}` as const, input: { objectId } };
    this.admission.mediaTap(focus.generation, focus.roomId, action, request, pass => {
      this.keep(operation, objectId, this.admission.spend(request, pass), focus, this.connection!);
    });
    if (action === 'RunArtifact' || action === 'OpenArtifactBrowser') {
      const metadata = { route: 'phone.readMediaMetadata' as const, input: { objectId } };
      this.admission.mediaTap(focus.generation, focus.roomId, action, metadata, pass => {
        this.keep('readMediaMetadata', objectId, this.admission.spend(metadata, pass), focus, this.connection!);
      });
    }
  }
  async dispatch<T>(operation: MediaOperation, objectId: string,
    send: (input: Readonly<{ objectId: string }>) => Promise<T>): Promise<T> {
    const key = JSON.stringify([operation, objectId]);
    const permit = this.pending.get(key);
    this.pending.delete(key);
    if (!permit || permit.wire.operation !== operation || !permit.isCurrent()) throw new Error('File demand is not current.');
    for (let failures = 0; ; failures++) {
      try {
        return await this.execute(async () => {
          if (!permit.isCurrent()) throw new Error('File demand is not current.');
          const result = await send(Object.freeze(JSON.parse(permit.wire.input) as { objectId: string }));
          if (!permit.isCurrent()) throw new Error('File demand is not current.');
          return result;
        });
      } catch (error) {
        // Server identity/access removal is terminal even while this UI demand remains focused.
        const status = error && typeof error === 'object' && 'status' in error ? error.status : undefined;
        if (!permit.isCurrent() || status === 401 || status === 403 || status === 404 || status === 410) throw error;
        await this.pause(Math.min(30_000, 500 * 2 ** Math.min(failures, 6)));
      }
    }
  }
  private async execute<T>(work: () => Promise<T>): Promise<T> {
    if (this.active >= 8) await new Promise<void>(resolve => this.waiting.push(resolve));
    else this.active++;
    try { return await work(); }
    finally { const next = this.waiting.shift(); if (next) next(); else this.active--; }
  }
  private pause(delay: number): Promise<void> {
    return new Promise(resolve => {
      const finish = () => { clearTimeout(timer); this.sleepers.delete(finish); resolve(); };
      const timer = setTimeout(finish, delay); this.sleepers.add(finish);
    });
  }
  private wake(): void { for (const finish of this.sleepers) finish(); }

  /** A current held value or an existing logical flight satisfies this exact
   * demand. Its unused wire opportunity cannot survive for a later cache miss.
   */
  satisfy(operation: MediaOperation, objectId: string): void {
    this.pending.delete(JSON.stringify([operation, objectId]));
  }
  private remember(objectId: string, runnable: boolean): void {
    const wasRunnable = this.known.get(objectId) === true;
    this.known.delete(objectId);
    this.known.set(objectId, runnable || wasRunnable);
    // Historical display metadata may be forgotten: a fresh read reauthorizes it.
    for (const id of this.known.keys()) {
      if (this.known.size <= 512) break;
      if (!this.visible.has(id) && !this.displays().includes(id)) this.known.delete(id);
    }
  }
  private keep(operation: MediaOperation, objectId: string, permit: Permit, focus: Focus, connection: object, recovery = false): void {
    const key = JSON.stringify([operation, objectId]); this.pending.delete(key);
    this.pending.set(key, { wire: permit.wire, isCurrent: () => {
      const current = this.current();
      return this.connection === connection && current?.screen === 'Room' && current.generation === focus.generation &&
        current.roomId === focus.roomId && permit.isCurrent() && (!recovery || this.visible.has(objectId) || this.displays().includes(objectId));
    } });
  }
}
