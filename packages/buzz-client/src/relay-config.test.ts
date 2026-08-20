import { describe, expect, it } from 'vitest';

import {
  DEFAULT_RELAY_BASE_URL,
  DEFAULT_RELAY_HOST,
  DEFAULT_RELAY_SCHEME,
  DEFAULT_RELAY_WS_URL,
  LEGACY_RELAY_HOST,
  PRODUCTION_RELAY_HOSTS,
  isProductionRelayHost,
} from './relay-config.js';

describe('production relay defaults', () => {
  it('matches the relay used to mint production pairing codes', () => {
    expect(DEFAULT_RELAY_HOST).toBe('usebeeline.app');
    expect(DEFAULT_RELAY_SCHEME).toBe('https');
    expect(DEFAULT_RELAY_BASE_URL).toBe('https://usebeeline.app');
    expect(DEFAULT_RELAY_WS_URL).toBe('wss://usebeeline.app');
  });

  it('keeps the shipped relay host as a permanent production alias', () => {
    expect(LEGACY_RELAY_HOST).toBe('relay.buzzrouter.com');
    expect(PRODUCTION_RELAY_HOSTS).toEqual(['usebeeline.app', 'relay.buzzrouter.com']);
    expect(isProductionRelayHost('usebeeline.app')).toBe(true);
    expect(isProductionRelayHost('relay.buzzrouter.com')).toBe(true);
    expect(isProductionRelayHost('relay.example')).toBe(false);
  });
});
