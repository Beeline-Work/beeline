import type { RoomViewMessage } from '@beeline/api-contract/phone';

export type ComputerSessionView = NonNullable<RoomViewMessage['computerSession']> & {
  access?: string; agentHandle?: string;
  /** In-memory capture from the mounted preview; never part of the Room DTO. */
  previewFrame?: Promise<string | null>;
};
