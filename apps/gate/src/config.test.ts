import { describe, expect, it } from 'vitest';

import { resolveRelayConfig } from './config.js';

describe('resolveRelayConfig', () => {
  it('uses the production relay in a clean environment', () => {
    expect(resolveRelayConfig({})).toEqual({
      host: 'usebeeline.app',
      scheme: 'https',
      baseUrl: 'https://usebeeline.app',
    });
  });

  it('retains host and scheme overrides for local development', () => {
    expect(
      resolveRelayConfig({
        BUZZY_RELAY_HOST: '127.0.0.1:3010',
        BUZZY_RELAY_SCHEME: 'http',
      }),
    ).toEqual({
      host: '127.0.0.1:3010',
      scheme: 'http',
      baseUrl: 'http://127.0.0.1:3010',
    });
  });
});
