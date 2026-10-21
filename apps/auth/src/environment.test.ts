import { describe, expect, it } from 'vitest';
import { authTenantsFromEnvironment, readEnv } from './environment.js';

describe.each(['AUTH_TENANTS_JSON', 'AUTH_SETUP_TOKEN', 'AUTH_HOST'])('%s aliases', (suffix) => {
  it('retains old configuration and prefers new values including empty values', () => {
    expect(readEnv({ ['BUZZY_' + suffix]: 'old' }, suffix)).toBe('old');
    expect(readEnv({ ['BUZZY_' + suffix]: 'old', ['BEELINE_' + suffix]: 'new' }, suffix)).toBe(
      'new',
    );
    expect(readEnv({ ['BUZZY_' + suffix]: 'old', ['BEELINE_' + suffix]: '' }, suffix)).toBe('');
  });
});
const tenants = [
  {
    host: 'localhost',
    community: 'fixture',
    roomCommunityIds: ['fixture'],
    origin: 'http://localhost',
  },
];
it.each(['BEELINE_', 'BUZZY_'])('loads auth tenants from %s config', (prefix) => {
  expect(
    authTenantsFromEnvironment({ [prefix + 'AUTH_TENANTS_JSON']: JSON.stringify(tenants) }),
  ).toEqual(tenants);
});
it('new tenant config wins over old and errors name the migration', () => {
  expect(
    authTenantsFromEnvironment({
      BEELINE_AUTH_TENANTS_JSON: JSON.stringify(tenants),
      BUZZY_AUTH_TENANTS_JSON: 'invalid',
    }),
  ).toEqual(tenants);
  expect(() => authTenantsFromEnvironment({})).toThrow(
    /BEELINE_AUTH_TENANTS_JSON.*BUZZY_AUTH_TENANTS_JSON/,
  );
});
