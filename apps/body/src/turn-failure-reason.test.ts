import { describe, expect, it } from 'vitest';
import { ModelSelectionUnavailableError } from './model-config.js';
import { distillTurnFailureReason, redactTurnError, TURN_FAILURE_REASON_MAX } from './turn-failure-reason.js';
import { AcpResourceLimitError, AcpRuntimeExitedError, AcpTurnBackstopError, TURN_BACKSTOP_MS } from './acp.js';
import { classifyTurnSilence, phraseTurnSilence } from '@beeline/api-contract/daemon';

describe('distillTurnFailureReason', () => {
  it.each([
    "env: node: No such file or directory",
    "/usr/bin/env: ‘node’: No such file or directory",
    "/usr/bin/env: 'node': No such file or directory",
  ])('harness-node-missing-path: keeps %s actionable through the Room receipt', diagnostic => {
    const raw = new AcpRuntimeExitedError(`ACP agent /${'long-install-path/'.repeat(25)}codex-acp exited code=127: ${diagnostic}`);
    const receipt = distillTurnFailureReason(raw);
    const phrase = phraseTurnSilence('@agent', classifyTurnSilence(receipt.text, receipt.kind), { givingUp: true });
    expect(phrase.consequence).toContain("background service can't find Node");
    expect(phrase.consequence).toContain('`beeline connect`');
    expect(phrase.consequence).not.toContain('runtime_exited');
    expect(redactTurnError(raw)).toContain(diagnostic);
  });

  it('keeps spawn ENOENT actionable without claiming the executable exists', () => {
    const receipt = distillTurnFailureReason(new AcpRuntimeExitedError('ACP agent /bin/agent: spawn /bin/agent ENOENT'));
    expect(receipt.text).toContain('program or interpreter is missing');
    expect(receipt.text).toContain('`beeline connect`');
  });

  it('keeps the journal stack while scrubbing its credential values', () => {
    const error = new Error('failed GH_TOKEN=ghp_abcdefghijklmnop');
    error.stack = `${error.message}\n    at prompt (/fixture/acp.js:12:1)`;
    expect(redactTurnError(error)).toContain('at prompt (/fixture/acp.js:12:1)');
    expect(redactTurnError(error)).not.toContain('ghp_abcdefghijklmnop');
    expect(redactTurnError(error)).toContain('[REDACTED]');
    expect(redactTurnError('failed token=fixture-secret')).not.toContain('fixture-secret');
  });
  it('keeps a cgroup memory failure as a terminal resource limit receipt', () => {
    const reason = distillTurnFailureReason(new AcpResourceLimitError(128 * 1024 * 1024));
    expect(reason).toEqual({
      text: 'resource_limit: ACP session likely hit its 128 MiB memory limit (exit 137 or signal 9)',
      kind: 'resource-limit',
    });
  });

  it.each([
    [new AcpRuntimeExitedError('ACP agent pi-acp exited code=7 signal=null'), 'runtime_exited'],
    [new AcpTurnBackstopError(TURN_BACKSTOP_MS, 'plan'), 'turn_backstop'],
  ])('keeps the layer cause in the receipt and stalled card', (error, cause) => {
    const reason = distillTurnFailureReason(error);
    expect(reason.text).toContain(cause);
    const card = phraseTurnSilence('Bee', classifyTurnSilence(reason.text, reason.kind));
    expect(card.consequence).toContain(cause);
    if (cause === 'turn_backstop') expect(card.consequence).toContain('45 minutes; last activity: plan');
  });
  it('keeps one line of the harness error and drops the stack', () => {
    const error = new Error('ACP error -32000: provider error 429 concurrency_limit');
    error.stack = `${error.message}\n    at AcpClient.request (/opt/beeline/acp.js:984:20)\n    at async prompt (/opt/beeline/turn.js:1:1)`;
    expect(distillTurnFailureReason(error).text).toBe(
      'provider error 429 concurrency_limit'.replace(/^/, 'ACP error -32000: '),
    );
    expect(distillTurnFailureReason(error).text).not.toMatch(/\n|\bat\s/);
  });

  it('keeps a Codex quota and reset time that rode in on a flattened stderr tail', () => {
    expect(
      distillTurnFailureReason(
        new Error(
          "ACP error -32603: Codex process has exited with code 0; harness stderr: You've hit your usage limit. Upgrade to Pro for more usage, or try again at Sep 19th, 2026 4:09 AM.",
        ),
      ).text,
    ).toMatch(/usage limit.*Sep 19th, 2026 4:09 AM/);
  });

  it('takes the first informative line of a multi-line message and strips the Error: prefix', () => {
    expect(
      distillTurnFailureReason(
        new Error('\nTypeError: ACP session timed out after 120000ms of inactivity\n    at x'),
      ),
    ).toEqual({
      text: 'ACP session timed out after 120000ms of inactivity',
      kind: 'hiccup',
    });
    expect(distillTurnFailureReason('ACP agent exited (code 1)')).toEqual({
      text: 'ACP agent exited (code 1)',
      kind: 'hiccup',
    });
    expect(distillTurnFailureReason({ message: 'exit 137' })).toEqual({
      text: 'exit 137',
      kind: 'hiccup',
    });
    expect(distillTurnFailureReason(undefined)).toEqual({ text: 'turn failed', kind: 'hiccup' });
    expect(distillTurnFailureReason(new Error('   '))).toEqual({
      text: 'turn failed',
      kind: 'hiccup',
    });
  });

  it('classifies model selection unavailability without sending its id or advice', () => {
    const failure = distillTurnFailureReason(
      new ModelSelectionUnavailableError({
        label: 'model',
        value: 'claude-fable-5-1[1m]',
        reason: 'not-advertised',
      }),
    );
    expect(failure).toEqual({
      text: 'model selection unavailable',
      kind: 'model-selection-unavailable',
    });
    expect(JSON.stringify(failure)).not.toMatch(/claude-fable|catalog/i);
  });

  it('scrubs credentials before the reason leaves the daemon', () => {
    const reason = distillTurnFailureReason(
      new Error(
        '401 from https://openrouter.ai Authorization: Bearer sk-or-v1-abcdefghijklmnop api_key=sk-live-1234567890abcdef ghp_abcdefghijklmnopqrstuvwxyz',
      ),
    );
    expect(reason.text).not.toMatch(/sk-or-v1|sk-live|ghp_abc/);
    expect(reason.text).toContain('[REDACTED]');
  });

  it(`caps the line at ${TURN_FAILURE_REASON_MAX} characters`, () => {
    const reason = distillTurnFailureReason(new Error('x'.repeat(1_000)));
    expect(reason.text).toHaveLength(TURN_FAILURE_REASON_MAX);
    expect(reason.text.endsWith('…')).toBe(true);
    expect(reason.kind).toBe('hiccup');
  });

  it('terminates explicit ACP authentication refusals and retains token-refresh retries', () => {
    expect(distillTurnFailureReason(new Error('ACP error -32000: Authentication required')))
      .toEqual({ text: 'Authentication required: the agent needs to sign in again', kind: 'not-signed-in' });
    expect(
      distillTurnFailureReason(
        new Error('401 authentication_error: OAuth token refresh in progress, retry'),
      ).kind,
    ).toBe('hiccup');
  });

  it('classifies standing conditions before they leave the daemon', () => {
    expect(
      distillTurnFailureReason(
        new Error(
          "ACP error -32603: Codex process has exited with code 0; harness stderr: You've hit your usage limit. Upgrade to Pro for more usage, or try again at Sep 19th, 2026 4:09 AM.",
        ),
      ).kind,
    ).toBe('allowance-spent');
    expect(
      distillTurnFailureReason(new Error('fatal: repository not found github.com/acme/widgets.git'))
        .kind,
    ).toBe('workspace-failure');
    expect(
      distillTurnFailureReason(new Error('corner parent Room repository state is not verified yet'))
        .kind,
    ).toBe('workspace-failure');
    expect(
      distillTurnFailureReason(new Error('corner parent Room has an incomplete repository binding'))
        .kind,
    ).toBe('workspace-failure');
    expect(
      distillTurnFailureReason(new Error('corner has no authoritative objective fact')).kind,
    ).toBe('workspace-failure');
    expect(distillTurnFailureReason(new Error('profile_busy: chrome in use')).kind).toBe(
      'workspace-failure',
    );
    expect(distillTurnFailureReason(new Error('broker unavailable')).kind).toBe(
      'workspace-failure',
    );
    expect(
      distillTurnFailureReason(
        new Error(
          'Command failed: git clone https://github.example/acme/widgets.git\nfatal: unable to access repository',
        ),
      ).kind,
    ).toBe('workspace-failure');
  });

  it('marks a context-window overflow so the server does not restart the helper for it', () => {
    expect(
      distillTurnFailureReason(
        new Error(
          "provider error 400: This endpoint's maximum context length is 1048576 tokens. However, you requested about 1053212 tokens (109494 of text input, 943718 in the output). · routed to morph",
        ),
      ).kind,
    ).toBe('context-overflow');
  });
});
