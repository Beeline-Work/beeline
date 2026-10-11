import type { ComputerSessionView } from '@/components/buzz/ComputerSession';

const listeners = new Set<(session: ComputerSessionView) => boolean>();

export function openComputerInDesktopWorkPane(session: ComputerSessionView): boolean {
  for (const listener of listeners) if (listener(session)) return true;
  return false;
}

export function subscribeDesktopComputer(listener: (session: ComputerSessionView) => boolean): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
