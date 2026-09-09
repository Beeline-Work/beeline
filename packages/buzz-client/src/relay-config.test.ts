import { describe, expect, it } from 'vitest';

import {
  DEFAULT_RELAY_BASE_URL,
  DEFAULT_RELAY_HOST,
  DEFAULT_RELAY_SCHEME,
  DEFAULT_RELAY_WS_URL,
  PRODUCTION_RELAY_HOSTS,
  isProductionRelayHost,
} from './relay-config.js';

describe('isolated relay defaults', () => {
  it('defaults relay tooling to the local stack', () => {
    expect(DEFAULT_RELAY_HOST).toBe('127.0.0.1:3010');
    expect(DEFAULT_RELAY_SCHEME).toBe('http');
    expect(DEFAULT_RELAY_BASE_URL).toBe('http://127.0.0.1:3010');
    expect(DEFAULT_RELAY_WS_URL).toBe('ws://127.0.0.1:3010');
  });

  it('does not classify retired relay hosts as production', () => {
    expect(PRODUCTION_RELAY_HOSTS).toEqual(['127.0.0.1:3010']);
    expect(isProductionRelayHost('127.0.0.1:3010')).toBe(true);
    expect(isProductionRelayHost('relay.example')).toBe(false);
  });
});
