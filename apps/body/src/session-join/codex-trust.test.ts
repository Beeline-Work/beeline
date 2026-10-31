import { describe, expect, it } from 'vitest';
import { beelineTrustEdits, trustCodexHook } from './codex-trust.js';
import { hookCommand } from './setup.js';

const context = { env: { CODEX_HOME: '/proof/codex' }, node: '/node', bundle: '/bundle' };
const hook = { key: '/proof/codex/hooks.json:session_start:1:0', sourcePath: '/proof/codex/hooks.json', source: 'user',
  eventName: 'sessionStart', handlerType: 'command', command: hookCommand(context, 'codex', 'session-start'), matcher: '*',
  timeoutSec: 10, currentHash: `sha256:${'a'.repeat(64)}`, isManaged: false, pluginId: null };

describe('Codex hook trust after Allow', () => {
  it('trusts only the exact Beeline hook, pinned to the installed definition’s Codex hash', () => {
    const others = [{ ...hook, key: 'other', command: '/another/hook' }, { ...hook, sourcePath: '/project/hooks.json', key: 'project' }];
    expect(beelineTrustEdits([...others, hook], context)).toEqual([{ keyPath: `hooks.state.${JSON.stringify(hook.key)}.trusted_hash`,
      value: hook.currentHash, mergeStrategy: 'replace' }]);
    expect(beelineTrustEdits([{ ...hook, currentHash: `sha256:${'b'.repeat(64)}` }], context)[0]?.value).toBe(`sha256:${'b'.repeat(64)}`);
  });
  it('leaves unknown formats and changed or ambiguous declarations for Codex’s prompt', () => {
    for (const changed of [{ currentHash: 'future-format' }, { command: `${hook.command} --other` }, { timeoutSec: 20 }, { matcher: 'other' },
      { source: 'project' }, { pluginId: 'foreign' }, { eventName: 'stop' }, { handlerType: 'prompt' }])
      expect(beelineTrustEdits([{ ...hook, ...changed }], context)).toEqual([]);
    expect(beelineTrustEdits([hook, hook], context)).toEqual([]);
  });
  it('falls back without changing config when the installed CLI lacks the trust API', async () => {
    expect(await trustCodexHook(context, '/missing/codex', '/tmp')).toBe(false);
  });
});
