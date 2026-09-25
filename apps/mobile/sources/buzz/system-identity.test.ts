import { expect, it } from 'vitest';
import { SYSTEM_IDENTITY_ID } from '../../../../packages/api-contract/src/system-identity';
import { SYSTEM_IDENTITY_PUBKEY } from './system-identity';

it('uses the server-owned System identity for the mobile logo', () => {
  expect(SYSTEM_IDENTITY_PUBKEY).toBe(SYSTEM_IDENTITY_ID);
});
