import { readFileSync } from 'node:fs';
import { getDefaultAutoSelectFamilyAttemptTimeout } from 'node:net';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import {
  configureNetworkFamilyDefaults,
  NETWORK_FAMILY_ATTEMPT_TIMEOUT_MS,
} from './network-family-bootstrap.js';

describe('network family bootstrap', () => {
  it('loads before the daemon API module in the shared CLI entrypoint', () => {
    const cli = readFileSync(fileURLToPath(new URL('./cli.ts', import.meta.url)), 'utf8');

    expect(cli.indexOf("import './network-family-bootstrap.js';")).toBeGreaterThan(-1);
    expect(cli.indexOf("import './network-family-bootstrap.js';")).toBeLessThan(
      cli.indexOf("from './daemon-api-client.js';"),
    );
  });

  it('sets the process default to a generous address-attempt timeout', () => {
    const setAttemptTimeout = vi.fn();
    const setAutoSelectFamily = vi.fn();

    const strategy = configureNetworkFamilyDefaults({
      setDefaultAutoSelectFamilyAttemptTimeout: setAttemptTimeout,
      setDefaultAutoSelectFamily: setAutoSelectFamily,
    });

    expect(strategy).toBe('timeout');
    expect(setAttemptTimeout).toHaveBeenCalledWith(NETWORK_FAMILY_ATTEMPT_TIMEOUT_MS);
    expect(setAutoSelectFamily).not.toHaveBeenCalled();
    expect(getDefaultAutoSelectFamilyAttemptTimeout()).toBe(NETWORK_FAMILY_ATTEMPT_TIMEOUT_MS);
  });

  it('disables family autoselection when the timeout API is unavailable', () => {
    const setAutoSelectFamily = vi.fn();

    expect(
      configureNetworkFamilyDefaults({ setDefaultAutoSelectFamily: setAutoSelectFamily }),
    ).toBe('autoselection-disabled');
    expect(setAutoSelectFamily).toHaveBeenCalledWith(false);
  });
});
