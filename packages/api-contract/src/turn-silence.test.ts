import { describe, expect, it } from 'vitest';
import { classifyTurnSilence } from './turn-silence.js';

describe('turn silence classification', () => {
  it.each(['-32600', '-32601', '-32602'])('WAKE-STORM: ACP %s is a standing adapter failure even on a legacy hiccup receipt', code => {
    const classified = classifyTurnSilence(`ACP error ${code}: Invalid params`, 'hiccup');
    expect(classified.kind).toBe('helper-out-of-date');

  });

  it('harness-node-missing-path: retains the interpreter diagnostic', () => {
    const reason = 'runtime_exited: ACP agent /nvm/bin/codex-acp exited code=127: env: node: No such file or directory';
    const classified = classifyTurnSilence(reason, 'hiccup');
    expect(classified.fault).toContain("background service can't find Node");
    expect(classifyTurnSilence('tool failed: env: node: No such file or directory').fault)
      .toContain('tool failed');
  });

  it('settles a session memory limit without retrying the same allocation', () => {
    const reason = 'resource_limit: ACP session exceeded its 8192 MiB memory limit';
    expect(classifyTurnSilence(reason)).toEqual({ kind: 'resource-limit' });
    expect(classifyTurnSilence(reason, 'resource-limit')).toEqual({ kind: 'resource-limit' });


    expect(classifyTurnSilence('resource_limit: ACP session likely hit its 8192 MiB memory limit'))
      .toEqual({ kind: 'resource-limit' });
  });

  it('names a context-window overflow and never restarts it as a hiccup', () => {
    const overflow =
      "provider error 400: This endpoint's maximum context length is 1048576 tokens. However, you requested about 1053212 tokens (109494 of text input, 943718 in the output). · routed to morph, cloudflare";
    expect(classifyTurnSilence(overflow)).toEqual({ kind: 'context-overflow' });
    expect(classifyTurnSilence('turn failed', 'context-overflow')).toEqual({
      kind: 'context-overflow',
    });


  });

  it('classifies transient faults without scheduling recovery', () => {
    expect(classifyTurnSilence(undefined).kind).toBe('hiccup');
    expect(classifyTurnSilence('the turn stalled').kind).toBe('hiccup');
    expect(
      classifyTurnSilence('the model ended its turn with no text (stop reason end_turn)').kind,
    ).toBe('hiccup');
    expect(classifyTurnSilence('ACP agent exited (code 1)').kind).toBe('hiccup');
    expect(classifyTurnSilence('provider error 429 concurrency_limit').kind).toBe('hiccup');
  });

  it('does not treat standing conditions as hiccups', () => {
    expect(
      classifyTurnSilence('model selection unavailable', 'model-selection-unavailable'),
    ).toEqual({
      kind: 'wrong-model',
    });
    expect(classifyTurnSilence("she's set to a model that isn't available").kind).toBe(
      'wrong-model',
    );
    expect(
      classifyTurnSilence(
        "You've hit your usage limit. Upgrade to Pro for more usage, or try again at Sep 19th, 2026 4:09 AM.",
      ),
    ).toEqual({
      kind: 'allowance-spent',
      allowanceUntil: 'Sep 19th, 2026 4:09 AM',
    });
    expect(classifyTurnSilence('provider error 402: This request requires more credits').kind).toBe(
      'allowance-spent',
    );
    expect(classifyTurnSilence('ACP error -32000: Authentication required').kind).toBe(
      'not-signed-in',
    );
    expect(classifyTurnSilence('fatal: repository not found github.com/acme/widgets.git')).toEqual({
      kind: 'workspace-failure',
      repo: 'acme/widgets',
    });
    expect(
      classifyTurnSilence(
        'Command failed: git clone https://github.example/acme/widgets.git fatal: unable to access repository',
      ).kind,
    ).toBe('workspace-failure');
    expect(
      classifyTurnSilence('corner parent Room repository state is not verified yet').kind,
    ).toBe('workspace-failure');
    expect(
      classifyTurnSilence('corner parent Room has an incomplete repository binding').kind,
    ).toBe('workspace-failure');
    expect(classifyTurnSilence('corner has no authoritative objective fact').kind).toBe(
      'workspace-failure',
    );
    expect(classifyTurnSilence('profile_busy: chrome in use').kind).toBe('workspace-failure');
    expect(classifyTurnSilence('broker unavailable').kind).toBe('workspace-failure');
    expect(classifyTurnSilence('server command protocol 1 is required; refusing intake').kind).toBe(
      'helper-out-of-date',
    );
    expect(classifyTurnSilence("Candy is offline - her helper isn't running").kind).toBe('offline');
    expect(classifyTurnSilence('the helper is unreachable').kind).toBe('offline');
    expect(classifyTurnSilence('old process stopped', 'update-interrupted').kind).toBe(
      'update-interrupted',
    );
  });

  it('lets an explicit receipt kind win over ambiguous text', () => {
    expect(classifyTurnSilence('provider error 429', 'wrong-model').kind).toBe('wrong-model');
    expect(classifyTurnSilence('temporary failure', 'hiccup')).toEqual({
      kind: 'hiccup',
      fault: 'temporary failure',
    });
  });
});
