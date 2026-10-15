import type { RoomView } from '@beeline/buzz-client';
export const fixture: RoomView;
export const controls: {
  cached: boolean;
  response: string;
  reads: number;
  requests: Array<{ resolve(value: RoomView): void; reject(error: unknown): void }>;
};
export function resetProof(cached?: boolean): void;
export function failRefresh(): void;
export function recoverServer(): void;
