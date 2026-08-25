/**
 * Positive, relay-independent evidence that a daemon reached its local Room
 * serving boundary. Update confirmation consumes this closed family so a
 * transport outage cannot look like a broken release, while a Room whose
 * persisted state cannot even load never produces a proof.
 */
export type DaemonServeProof =
  | { kind: 'room-local-ready'; roomId: string }
  | { kind: 'room-served'; roomId: string }
  | { kind: 'no-rooms' };
