import { useCallback, useSyncExternalStore } from 'react';
type Owner = { ids: ReadonlySet<string>; active: boolean };
const owners = new Map<string, Owner>();
const listeners = new Map<string, Set<() => void>>();
const visible = (id: string) => [...owners.values()].some(owner => owner.active && owner.ids.has(id));
function change(owner: string, next: Owner): void {
  const previous = owners.get(owner); const changed = new Set([...(previous?.ids ?? []), ...next.ids]);
  const before = new Map([...changed].map(id => [id, visible(id)]));
  owners.delete(owner); owners.set(owner, next);
  for (const id of changed) if (before.get(id) !== visible(id)) for (const listener of listeners.get(id) ?? []) listener();
  if (owners.size > 128) for (const [key, value] of owners) {
    if (owners.size <= 128) break;
    if (!value.active) owners.delete(key);
  }
}
/** Existing actual native/desktop viewport owner supplies row identities.
 * These local ids never become server subscriptions or cache inventories.
 */
export function observeArtifactRows(owner: string, ids: readonly string[]): void {
  change(owner, { ids: new Set(ids), active: owners.get(owner)?.active ?? false });
}
export function setArtifactViewportActive(owner: string, active: boolean): void {
  change(owner, { ids: owners.get(owner)?.ids ?? new Set(), active });
}
export function useArtifactRowVisible(messageId: string, enabled: boolean): boolean {
  const subscribe = useCallback((listener: () => void) => {
    if (!enabled) return () => {};
    const entry = listeners.get(messageId) ?? new Set(); entry.add(listener); listeners.set(messageId, entry);
    return () => { entry.delete(listener); if (!entry.size) listeners.delete(messageId); };
  }, [messageId, enabled]);
  const snapshot = useCallback(() => enabled && visible(messageId), [messageId, enabled]);
  return useSyncExternalStore(subscribe, snapshot, () => false);
}
