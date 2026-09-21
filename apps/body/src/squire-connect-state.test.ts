import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  connectStatusFromFacts,
  credentialFromSession,
  hostSeatDisplay,
  noteSquireVaultAuth,
  publishSquireVisibility,
  readSquireSession,
  readVaultFromSession,
  resetSquireConnectFacts,
  shouldStartSquireConnect,
  type SquireConnectFacts,
} from './squire-connect-state.js';

const roots: string[] = [];
afterEach(() => {
  resetSquireConnectFacts();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), 'squire-facts-'));
  roots.push(root);
  return root;
}

function facts(partial: Partial<SquireConnectFacts>): SquireConnectFacts {
  return {
    process: { kind: 'none' },
    visibility: { kind: 'none' },
    credential: { kind: 'none' },
    ...partial,
  };
}

describe('hostSeatDisplay', () => {
  it('uses a seat DISPLAY and ignores a virtual one', () => {
    const emptyX11 = scratch();
    expect(hostSeatDisplay({ env: { DISPLAY: ':0' }, x11Dir: emptyX11 })).toBe(':0');
    expect(hostSeatDisplay({ env: { DISPLAY: ':99' }, x11Dir: emptyX11 })).toBeUndefined();
  });

  it('treats Wayland as a real screen', () => {
    expect(hostSeatDisplay({ env: { WAYLAND_DISPLAY: 'wayland-0' } })).toBe(':0');
  });

  it('reads only seat X sockets from the x11 dir', () => {
    const dir = scratch();
    writeFileSync(join(dir, 'X99'), '');
    expect(hostSeatDisplay({ env: {}, x11Dir: dir })).toBeUndefined();
    writeFileSync(join(dir, 'X0'), '');
    expect(hostSeatDisplay({ env: {}, x11Dir: dir })).toBe(':0');
  });
});

describe('credential and connect status', () => {
  it('reads the session file this helper owns', () => {
    const home = scratch();
    mkdirSync(join(home, 'trusty-squire'));
    writeFileSync(
      join(home, 'trusty-squire', 'session.json'),
      JSON.stringify({
        api_base_url: 'https://vault.test',
        account_id: 'acct_9',
        agent_session_token: 'tok',
      }),
    );
    expect(readSquireSession(home)).toEqual({
      apiBaseUrl: 'https://vault.test',
      accountId: 'acct_9',
      agentSessionToken: 'tok',
    });
  });

  it('derives connected from a valid session, not from a running process', () => {
    const status = connectStatusFromFacts(
      facts({
        process: { kind: 'none' },
        visibility: { kind: 'none' },
        credential: { kind: 'valid', accountId: 'acct_9' },
      }),
    );
    expect(status).toBe('connected');
    expect(
      shouldStartSquireConnect(
        facts({ credential: { kind: 'valid', accountId: 'acct_9' } }),
      ),
    ).toBe(false);
  });

  it('does not start another browser when a ceremony is already published', () => {
    expect(
      shouldStartSquireConnect(
        facts({
          visibility: { kind: 'remote', held: false, url: 'https://tunnel.test/vnc' },
        }),
      ),
    ).toBe(false);
    expect(
      connectStatusFromFacts(
        facts({
          visibility: { kind: 'remote', held: false, url: 'https://tunnel.test/vnc' },
        }),
      ),
    ).toBe('installing');
  });

  it('waits when another agent holds the browser', () => {
    expect(
      shouldStartSquireConnect(
        facts({
          process: { kind: 'foreign', pid: 12, action: 'wait' },
        }),
      ),
    ).toBe(false);
  });

  it('marks a held surface without a session as a challenge', () => {
    publishSquireVisibility({ kind: 'local', held: true });
    expect(credentialFromSession(undefined)).toEqual({ kind: 'challenge' });
  });

  it('marks the credential expired after a 401 vault read', () => {
    noteSquireVaultAuth('expired');
    expect(
      credentialFromSession({
        apiBaseUrl: 'https://vault.test',
        accountId: 'acct_9',
        agentSessionToken: 'dead',
      }),
    ).toEqual({ kind: 'expired' });
  });
});

describe('readVaultFromSession', () => {
  it('lists KEYS from the session token without a broker', async () => {
    const home = scratch();
    mkdirSync(join(home, 'trusty-squire'));
    writeFileSync(
      join(home, 'trusty-squire', 'session.json'),
      JSON.stringify({
        api_base_url: 'https://vault.test',
        account_id: 'acct_9',
        agent_session_token: 'tok',
      }),
    );
    const vault = await readVaultFromSession({
      configHome: home,
      fetch: async (url, init) => {
        expect(String(url)).toBe('https://vault.test/v1/vault/credentials');
        expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer tok');
        return new Response(
          JSON.stringify({
            credentials: [{ reference: 'cred_groq', service: 'groq', label: 'Groq API' }],
          }),
        );
      },
    });
    expect(vault).toEqual([
      expect.objectContaining({ reference: 'cred_groq', label: 'Groq API', service: 'groq' }),
    ]);
  });

  it('does not invent KEYS when there is no session', async () => {
    expect(await readVaultFromSession({ configHome: scratch() })).toBeUndefined();
  });
});
