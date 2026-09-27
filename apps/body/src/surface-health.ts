export type SurfaceHealthStage = 'discovered' | 'subscribed' | 'intake-ready' | 'degraded';

export interface SurfaceHealthState {
  readonly id: string;
  readonly kind: 'room' | 'corner';
  readonly stage: SurfaceHealthStage;
  readonly reason?: string;
}

interface MutableSurfaceHealth {
  kind: SurfaceHealthState['kind'];
  subscribed: boolean;
  intakeReady: boolean;
  reason?: string;
}

/** Local observation only. Command delivery and membership remain server-owned. */
export class SurfaceHealth {
  private readonly surfaces = new Map<string, MutableSurfaceHealth>();

  discover(id: string, kind: SurfaceHealthState['kind']): void {
    const existing = this.surfaces.get(id);
    if (existing) existing.kind = kind;
    else this.surfaces.set(id, { kind, subscribed: false, intakeReady: false });
  }

  subscribed(id: string, connected: boolean): void {
    const surface = this.surfaces.get(id);
    if (!surface) return;
    surface.subscribed = connected;
    if (connected) surface.reason = undefined;
    else surface.reason = 'live subscription disconnected';
  }

  intakeReady(id: string): void {
    const surface = this.surfaces.get(id);
    if (!surface) return;
    surface.intakeReady = true;
    if (surface.subscribed) surface.reason = undefined;
  }

  degraded(id: string, reason: string): void {
    const surface = this.surfaces.get(id);
    if (surface) surface.reason = reason;
  }

  retain(ids: ReadonlySet<string>): void {
    for (const id of this.surfaces.keys()) if (!ids.has(id)) this.surfaces.delete(id);
  }

  remove(id: string): void {
    this.surfaces.delete(id);
  }

  snapshot(): SurfaceHealthState[] {
    return [...this.surfaces.entries()]
      .map(([id, state]) => ({
        id,
        kind: state.kind,
        stage: state.reason
          ? ('degraded' as const)
          : state.subscribed && state.intakeReady
            ? ('intake-ready' as const)
            : state.subscribed
              ? ('subscribed' as const)
              : ('discovered' as const),
        ...(state.reason ? { reason: state.reason } : {}),
      }))
      .sort((left, right) => left.id.localeCompare(right.id));
  }

  summary(): string {
    const states = this.snapshot();
    const count = (stage: SurfaceHealthStage) =>
      states.filter((item) => item.stage === stage).length;
    return `surfaces=${states.length} intake-ready=${count('intake-ready')} subscribed=${count('subscribed')} discovered=${count('discovered')} degraded=${count('degraded')}`;
  }

  hasDegraded(): boolean {
    return [...this.surfaces.values()].some((surface) => surface.reason !== undefined);
  }

  hasUnready(): boolean {
    return [...this.surfaces.values()].some(
      (surface) => surface.reason !== undefined || !surface.subscribed || !surface.intakeReady,
    );
  }
}
