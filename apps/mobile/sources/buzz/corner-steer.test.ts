import { describe, expect, it } from 'vitest';
import { isOfflineRoomDelivery } from './corner-steer';

describe('corner steer delivery', () => {
  it('never sends an open corner steer through the offline Room queue', () => {
    expect(isOfflineRoomDelivery(true, true)).toBe(false);
    expect(isOfflineRoomDelivery(true, false)).toBe(false);
    expect(isOfflineRoomDelivery(false, true)).toBe(true);
  });
});
