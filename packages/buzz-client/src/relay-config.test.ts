import { describe, expect, it } from 'vitest';

import {
  DEFAULT_RELAY_BASE_URL,
  DEFAULT_RELAY_HOST,
  DEFAULT_RELAY_SCHEME,
  DEFAULT_RELAY_WS_URL,
} from './relay-config.js';

describe('production relay defaults', () => {
  it('matches the relay used to mint production pairing codes', () => {
    expect(DEFAULT_RELAY_HOST).toBe('relay.buzzrouter.com');
    expect(DEFAULT_RELAY_SCHEME).toBe('https');
    expect(DEFAULT_RELAY_BASE_URL).toBe('https://relay.buzzrouter.com');
    expect(DEFAULT_RELAY_WS_URL).toBe('wss://relay.buzzrouter.com');
  });
});
