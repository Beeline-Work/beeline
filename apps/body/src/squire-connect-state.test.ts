import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  connectStatusFromFacts,
  credentialFromSession,
  noteSquireVaultAuth,
  publishSquireVisibility,
  readSquireSession,
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

  it('reads the pinned host config root, not an ambient XDG_CONFIG_HOME', () => {
    // Every helper-spawned Squire writes its session under <home>/.config,
    // because squireHostRewriteEnv pins XDG_CONFIG_HOME there. A daemon that
    // inherited some other XDG_CONFIG_HOME must still read what Squire wrote.
    const home = scratch();
    const ambient = scratch();
    for (const [root, account] of [
      [join(home, '.config'), 'acct_9'],
      [ambient, 'acct_ambient'],
    ] as const) {
      mkdirSync(join(root, 'trusty-squire'), { recursive: true });
      writeFileSync(
        join(root, 'trusty-squire', 'session.json'),
        JSON.stringify({
          api_base_url: 'https://vault.test',
          account_id: account,
          agent_session_token: 'tok',
        }),
      );
    }
    const previous = { home: process.env.HOME, config: process.env.XDG_CONFIG_HOME };
    process.env.HOME = home;
    process.env.XDG_CONFIG_HOME = ambient;
    try {
      expect(readSquireSession()?.accountId).toBe('acct_9');
    } finally {
      if (previous.home === undefined) delete process.env.HOME;
      else process.env.HOME = previous.home;
      if (previous.config === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = previous.config;
    }
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
    // A live token still reads connected, but it is not a refusal: Squire
    // decides whether the profile needs a ceremony, so Connect always runs.
    expect(
      shouldStartSquireConnect(
        facts({ credential: { kind: 'valid', accountId: 'acct_9' } }),
      ),
    ).toBe(true);
  });

  it('does not hand back a ceremony nobody is running', () => {
    // The surface is still published but no process holds it, so the next
    // attempt raises a new one rather than re-serving a dead tunnel.
    expect(
      shouldStartSquireConnect(
        facts({
          visibility: { kind: 'remote', held: false, url: 'https://tunnel.test/vnc' },
        }),
      ),
    ).toBe(true);
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

  it('lets this helper retry its own live connect', () => {
    expect(
      shouldStartSquireConnect(facts({ process: { kind: 'ours', pid: 9 } })),
    ).toBe(true);
  });

  it('marks a held surface without a session as a challenge', () => {
    publishSquireVisibility({ kind: 'remote', held: true, url: 'https://tunnel.test/#p=x' });
    expect(credentialFromSession(undefined)).toEqual({ kind: 'challenge' });
  });

  it('marks the credential expired after a refused vault read', () => {
    noteSquireVaultAuth('expired');
    const credential = credentialFromSession({
      apiBaseUrl: 'https://vault.test',
      accountId: 'acct_9',
      agentSessionToken: 'dead',
    });
    expect(credential).toEqual({ kind: 'expired' });
    // A refusal is the one answer that sends Connect/Retry to a ceremony.
    expect(shouldStartSquireConnect(facts({ credential }))).toBe(true);
  });

  it('calls a session valid only once the vault has answered for its token', () => {
    const session = {
      apiBaseUrl: 'https://vault.test',
      accountId: 'acct_9',
      agentSessionToken: 'tok',
    };
    // Nothing answered for this file yet: not connected, and not a reason
    // to raise another browser over a session that may be perfectly good.
    const unproven = credentialFromSession(session);
    expect(unproven).toEqual({ kind: 'unproven' });
    expect(connectStatusFromFacts(facts({ credential: unproven }))).toBe('installing');
    expect(shouldStartSquireConnect(facts({ credential: unproven }))).toBe(false);
    noteSquireVaultAuth('ok');
    expect(credentialFromSession(session)).toEqual({ kind: 'valid', accountId: 'acct_9' });
    expect(
      connectStatusFromFacts(facts({ credential: credentialFromSession(session) })),
    ).toBe('connected');
  });
});
