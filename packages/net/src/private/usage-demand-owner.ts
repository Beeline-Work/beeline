import type { AdmissionOwner } from './admission.js';
type Navigation = Readonly<{ generation: number; screen: string; agentId?: string }>;
type Selection = { agentId: string; navigation: number; generation: number };
type Permit = { wire: Readonly<{ operation: string; input: string }>; isCurrent(): boolean };
/** Committed Profile route/work-pane ownership, independent from React observer
 * mounts. Only the exact canonical cell read is exposed through this adapter.
 */
export class UsageDemandOwner {
  private selected?: Selection;
  private pending?: Permit;
  private connection?: object;
  private lastConnection = -1;
  private generation = 0;
  constructor(private readonly admission: AdmissionOwner, private readonly navigation: () => Navigation | null,
    private readonly changed: (agentId: string | null) => void) {}
  profile(agentId: string | null): void {
    const current = this.navigation();
    if (!agentId) { this.close(); return; }
    if (!current || !['Room', 'AgentProfile'].includes(current.screen) || current.screen === 'AgentProfile' && current.agentId !== agentId) return;
    if (this.selected?.agentId === agentId && this.selected.navigation === current.generation) return;
    this.admission.clearUsageFocus(); this.pending = undefined;
    const selected = { agentId, navigation: current.generation, generation: ++this.generation };
    this.selected = selected;
    if (this.connection) {
      const request = { route: 'phone.readAgentUsageCell' as const, input: { agentId } };
      const pass = this.admission.usageProfile(selected.generation, agentId);
      this.keep(this.admission.spend(request, pass), selected, this.connection);
    }
    // Admission precedes the source owner's initial asynchronous read.
    this.changed(agentId);
  }
  navigationChanged(): void {
    const selected = this.selected; const current = this.navigation();
    if (!selected) return;
    if (!current) { this.admission.clearUsageFocus(); this.pending = undefined; return; }
    if (current.generation !== selected.navigation || current.screen === 'AgentProfile' && current.agentId !== selected.agentId) this.close();
  }
  connected(generation: number): void {
    if (!Number.isSafeInteger(generation) || generation < 0 || generation <= this.lastConnection) return;
    this.lastConnection = generation; this.connection = {}; this.pending = undefined; this.navigationChanged();
    const selected = this.selected; const current = this.navigation();
    if (!selected || !current || current.generation !== selected.navigation) return;
    const request = { route: 'phone.readAgentUsageCell' as const, input: { agentId: selected.agentId } };
    const pass = this.admission.usageRecovery(generation, selected.generation, selected.agentId);
    this.keep(this.admission.spend(request, pass), selected, this.connection);
  }
  disconnected(): void { this.connection = undefined; this.pending = undefined; this.admission.clearUsageFocus(); }
  satisfy(agentId: string): void { if (this.selected?.agentId === agentId) this.pending = undefined; }
  async dispatch<T>(agentId: string, send: (input: Readonly<{ agentId: string }>) => Promise<T>): Promise<T> {
    const permit = this.pending;
    if (this.selected?.agentId !== agentId || !permit || permit.wire.operation !== 'readAgentUsageCell' || !permit.isCurrent())
      throw new Error('Usage profile is not current.');
    this.pending = undefined;
    const result = await send(Object.freeze(JSON.parse(permit.wire.input) as { agentId: string }));
    if (!permit.isCurrent()) throw new Error('Usage profile is not current.');
    return result;
  }
  private close(): void {
    if (!this.selected) return;
    this.admission.clearUsageFocus(); this.selected = undefined; this.pending = undefined; this.changed(null);
  }
  private keep(permit: Permit, selected: Selection, connection: object): void {
    this.pending = { wire: permit.wire, isCurrent: () => {
      const current = this.navigation();
      return this.connection === connection && this.selected === selected && current?.generation === selected.navigation &&
        (current.screen !== 'AgentProfile' || current.agentId === selected.agentId) && permit.isCurrent();
    } };
  }
}
