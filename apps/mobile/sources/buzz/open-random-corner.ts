import { v4 as randomUUID } from 'uuid';
import { cornerOpenEnded, cornerOpenStarted } from './corner-open-status';
import { randomCornerName } from './random-corner-name';

/**
 * One corner open: its name and the id the phone chose for it. A retry
 * repeats the same attempt, so the server returns the corner the first try
 * created instead of opening a second one.
 */
export type CornerOpenAttempt = { title: string; cornerId: string };

export function newCornerOpenAttempt(random?: () => number): CornerOpenAttempt {
  return { title: randomCornerName(random), cornerId: randomUUID() };
}

export type OpenRandomNamedCornerInput = {
  createCorner: (roomId: string, title: string, cornerId: string) => Promise<string>;
  roomId: string;
  openCorner: (cornerId: string, title: string) => void;
  random?: () => number;
  /** The attempt to repeat; a fresh one when absent. */
  attempt?: CornerOpenAttempt;
};

/**
 * Create a human corner whose name is three words ending in `corner`, then open
 * it. Each entry point owns its own trigger description. The create shows as
 * pending (`corner-open-status`) while it is in flight.
 */
export async function openRandomNamedCorner(
  input: OpenRandomNamedCornerInput,
): Promise<{ id: string; title: string }> {
  const { title, cornerId } = input.attempt ?? newCornerOpenAttempt(input.random);
  cornerOpenStarted(input.roomId);
  let id: string;
  try {
    id = await input.createCorner(input.roomId, title, cornerId);
  } finally {
    cornerOpenEnded();
  }
  input.openCorner(id, title);
  return { id, title };
}
