import type { ComputerSessionView } from '@/components/buzz/ComputerSession';

type WarmComputer = {
  session: ComputerSessionView;
  roomId?: string;
  agentHandle?: string;
  visible: boolean;
};
let current: WarmComputer | null = null;
let hosts = 0;
const cards = new Map<string, WarmComputer>();
const listeners = new Set<() => void>();
const publish = (next: WarmComputer | null) => {
  current = next;
  for (const listener of listeners) listener();
};
export const readWarmComputerSession = () => current;
export function subscribeWarmComputerSession(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
export function attachWarmComputerHost() {
  hosts++;
  return () => { if (--hosts === 0) { cards.clear(); publish(null); } };
}

/** At most one full viewer is preloaded, alongside the latest mounted card. */
export function warmComputerSession(session: ComputerSessionView, roomId?: string, agentHandle?: string) {
  const entry = { session, roomId, agentHandle, visible: false };
  cards.delete(session.id);
  cards.set(session.id, entry);
  if (!current?.visible) publish(entry);
  return () => {
    if (cards.get(session.id) !== entry) return;
    cards.delete(session.id);
    if (current?.session.id === session.id && !current.visible)
      publish([...cards.values()].at(-1) ?? null);
  };
}

/** Reveal the same native WebView; its source and React parent never change. */
export function openWarmComputerSession(session: ComputerSessionView, roomId?: string, agentHandle?: string) {
  if (!hosts || current?.session.id !== session.id || current.session.access !== session.access) return false;
  publish({ ...current, roomId, agentHandle, visible: true });
  return true;
}
export function closeWarmComputerSession() {
  if (!current) return;
  const mounted = cards.get(current.session.id);
  publish(mounted ?? [...cards.values()].at(-1) ?? null);
}
