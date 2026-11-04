import { readAgentUsageCellValue, type AgentUsageCell } from '@beeline/api-contract/helper-usage';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import { subscribeClientReset } from '@/sync/client-reset';
export type UsageCellView = Readonly<{ mode: 'pending' | 'legacy' | 'router'; cell: AgentUsageCell | null }>;
type Connection = Readonly<{ generation: number; usageCellV1: boolean; origin: string; principal: string;
  executeRead(agentId: string): Promise<AgentUsageCell>; joinedRead?(agentId: string): void }>;
type Fence = Readonly<{ generation: string; revision: number; allowed: boolean }>;
const pending: UsageCellView = Object.freeze({ mode: 'pending', cell: null });
const legacy: UsageCellView = Object.freeze({ mode: 'legacy', cell: null });
const listeners = new Set<() => void>();
const fences = new Map<string, Fence>();
let connection: Connection | undefined;
let partition = '';
let installedGeneration = -1;
let profile: string | null = null;
let profileEpoch = 0;
let value: UsageCellView = pending;
let flight: Promise<void> | undefined;
let blocked: { agentId: string; revision: number | null } | undefined;
const notify = () => { for (const listener of listeners) listener(); };
function cell(value: unknown): AgentUsageCell | undefined {
  const canonical = readAgentUsageCellValue(value);
  if (!canonical) return;
  try { return utf8ToBytes(JSON.stringify(value)).byteLength <= 32 * 1024 ? canonical : undefined; } catch { return; }
}
function accept(raw: unknown, snapshot: boolean): void {
  const owner = connection;
  const canonical = cell(raw);
  if (!owner?.usageCellV1) return;
  if (!canonical) {
    const item = raw && typeof raw === 'object' ? raw as Record<string, unknown> : undefined;
    if (profile && item?.agentId === profile && item.ownerId === owner.principal) {
      const revision = Number.isSafeInteger(item.revision) && Number(item.revision) >= 1 ? Number(item.revision) : null;
      const prior = fences.get(profile);
      if (revision !== null && prior && revision <= prior.revision) return;
      blocked = { agentId: profile, revision }; profileEpoch++; flight = undefined; value = pending; notify();
    }
    return;
  }
  if (canonical.ownerId !== owner.principal) return;
  const incoming = canonical;
  if (!snapshot && incoming.allowed && blocked?.agentId === incoming.agentId &&
      (blocked.revision === null || incoming.revision <= blocked.revision)) return;
  const previous = fences.get(incoming.agentId);
  if (previous && (incoming.revision < previous.revision || incoming.revision === previous.revision &&
      (!snapshot || incoming.generation !== previous.generation || incoming.allowed !== previous.allowed))) return;
  // Revocation ordering metadata is never evicted to make space for stale data.
  if (!previous && fences.size >= 512) return;
  fences.set(incoming.agentId, { generation: incoming.generation, revision: incoming.revision, allowed: incoming.allowed });
  if (profile !== incoming.agentId) return;
  if (incoming.allowed) blocked = undefined;
  value = Object.freeze({ mode: 'router', cell: incoming }); notify();
}
function readFocused(): void {
  const owner = connection; const agentId = profile; const epoch = profileEpoch;
  if (!owner?.usageCellV1 || !agentId || flight) return;
  let pendingRead: Promise<void>;
  pendingRead = Promise.resolve().then(() => {
    if (connection !== owner || profile !== agentId || profileEpoch !== epoch) return;
    if (value.mode === 'router' && value.cell?.agentId === agentId) { owner.joinedRead?.(agentId); return; }
    return owner.executeRead(agentId);
  }).then(result => {
    if (!result) return;
    if (connection !== owner || profile !== agentId || profileEpoch !== epoch) return;
    if (!cell(result) || result.agentId !== agentId || result.ownerId !== owner.principal) throw new Error('Invalid usage cell.');
    accept(result, true);
  }).catch(() => {
    // A failure parks. It does not read profile/Workbench, retry or create a timer.
    if (connection === owner && profile === agentId && profileEpoch === epoch && value.cell === null) { value = pending; notify(); }
  }).finally(() => { if (flight === pendingRead) flight = undefined; });
  flight = pendingRead;
}
/** Sole authenticated socket owner installs this independently negotiated read
 * adapter. Its private profile admission must already be ready before install.
 */
export function installUsageCellConnection(next: Connection): void {
  const key = JSON.stringify([new URL(next.origin).origin, next.principal]);
  if (partition !== key) { fences.clear(); partition = key; installedGeneration = -1; }
  if (!Number.isSafeInteger(next.generation) || next.generation < 0 || next.generation <= installedGeneration) return;
  installedGeneration = next.generation;
  connection = next; profileEpoch++; flight = undefined; blocked = undefined; value = next.usageCellV1 ? pending : legacy; notify(); readFocused();
}
export function suspendUsageCellConnection(): void {
  connection = undefined; profileEpoch++; flight = undefined; value = pending; notify();
}
/** Called by the existing committed navigation/work-pane owner. React effect
 * observers only subscribe; repeating the same selection cannot grant reads.
 */
export function setUsageCellProfile(agentId: string | null): void {
  if (profile === agentId) return;
  profile = agentId; profileEpoch++; flight = undefined; blocked = undefined;
  value = connection?.usageCellV1 ? pending : connection ? legacy : pending; notify(); readFocused();
}
export function receiveUsageCell(incoming: unknown): void { accept(incoming, false); }
export function usageCellSnapshot(agentId: string | null | undefined): UsageCellView {
  if (connection && !connection.usageCellV1) return legacy;
  return agentId && agentId === profile ? value : pending;
}
export function subscribeUsageCell(listener: () => void): () => void { listeners.add(listener); return () => { listeners.delete(listener); }; }
subscribeClientReset(() => {
  suspendUsageCellConnection(); profile = null; fences.clear(); partition = ''; installedGeneration = -1;
});

/** Only the negotiated canonical usage family can suppress its precise
 * compatibility hint. Identity/config/grant events retain their existing path.
 */
export function isUsageCellOnlyChange(value: unknown): boolean {
  if (!connection?.usageCellV1 || !value || typeof value !== 'object') return false;
  const event = value as Record<string, unknown>;
  return event.type === 'resource-change' && event.resource === 'agent' && event.usageOnly === true;
}
