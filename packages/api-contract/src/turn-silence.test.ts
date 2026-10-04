import { describe, expect, it } from 'vitest';
import {
  type ClassifiedTurnSilence,
  classifyTurnSilence,
  HICCUP_ATTEMPT_LIMIT,
  phraseTurnSilence,
  shouldCompletePendingFailedCommand,
  shouldRestartHiccup,
  TURN_SILENCE_LINE_MAX,
} from './turn-silence.js';

describe('turn silence classification', () => {
  it('names a context-window overflow and never restarts it as a hiccup', () => {
    const overflow =
      "provider error 400: This endpoint's maximum context length is 1048576 tokens. However, you requested about 1053212 tokens (109494 of text input, 943718 in the output). · routed to morph, cloudflare";
    expect(classifyTurnSilence(overflow)).toEqual({ kind: 'context-overflow' });
    expect(classifyTurnSilence('turn failed', 'context-overflow')).toEqual({
      kind: 'context-overflow',
    });
    expect(shouldRestartHiccup('context-overflow', 1)).toBe(false);
    expect(shouldCompletePendingFailedCommand('context-overflow')).toBe(true);
    const phrase = phraseTurnSilence('Ronnie', { kind: 'context-overflow' });
    expect(phrase.verb).toBe('could not answer');
    expect(phrase.consequence).toBe(
      "the request no longer fits the model's context window. Start a new corner, or pick a model with a larger window.",
    );
    expect(phrase.consequence).not.toContain('Restarting');
  });

  it('maps the four hiccup causes onto one restart class', () => {
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

describe('turn silence phrasing', () => {
  it('uses the approved remedies and stays inside the 200-character cap', () => {
    const lines = [
      phraseTurnSilence('Candy', { kind: 'hiccup', fault: 'the turn stalled' }),
      phraseTurnSilence('Candy', { kind: 'wrong-model' }),
      phraseTurnSilence('Candy', {
        kind: 'allowance-spent',
        allowanceUntil: 'Sep 19th, 2026 4:09 AM',
      }),
      phraseTurnSilence('Candy', { kind: 'not-signed-in' }),
      phraseTurnSilence('Candy', { kind: 'workspace-failure', repo: 'acme/widgets' }),
      phraseTurnSilence('Candy', { kind: 'helper-out-of-date' }),
      phraseTurnSilence('Candy', { kind: 'offline' }),
      phraseTurnSilence('Candy', { kind: 'update-interrupted' }),
    ];
    expect(lines.map((line) => `Candy ${line.verb} · ${line.consequence}`)).toEqual([
      'Candy could not answer · the turn stalled. Resending your message.',
      "Candy could not answer · the selected model isn't available. Pick another in the agent's settings.",
      'Candy could not answer · the provider allowance is spent until Sep 19th, 2026 4:09 AM. Top up, or move the agent to another provider.',
      "Candy could not answer · the helper could not authenticate with the provider. Check its log for the failed turn; if its login expired, run `beeline connect` on the helper's machine.",
      "Candy could not answer · the helper couldn't get a working copy of acme/widgets. Check the repository is reachable.",
      "Candy could not answer · the helper is out of date. Run `beeline start` on the helper's machine.",
      "Candy is offline · the helper isn't running. Run `beeline start` on the helper's machine.",
      'Candy was interrupted by an update · the request is queued to resume.',
    ]);
    for (const line of lines) {
      expect(`Candy ${line.verb} · ${line.consequence}`.length).toBeLessThanOrEqual(
        TURN_SILENCE_LINE_MAX,
      );
    }
  });

  it('tells a Claude agent owner to send @agent login, keeping beeline connect as the fallback', () => {
    const line = phraseTurnSilence('Candy', { kind: 'not-signed-in' }, {
      login: { handle: 'candy', harness: 'claude' },
    });
    expect(`Candy ${line.verb} · ${line.consequence}`).toBe(
      "Candy could not answer · the helper could not authenticate with Claude. If its login expired, its owner can send `@candy /login` here, or run `beeline connect` on its machine.",
    );
    expect(`@candy ${line.verb} · ${line.consequence}`.length).toBeLessThanOrEqual(
      TURN_SILENCE_LINE_MAX,
    );
  });

  it('names the service, or the key, for every harness that signs in from a Room', () => {
    const consequence = (harness: 'codex' | 'grok' | 'cursor' | 'pi') =>
      phraseTurnSilence('Candy', { kind: 'not-signed-in' }, { login: { handle: 'candy', harness } })
        .consequence;
    expect(consequence('codex')).toContain('could not authenticate with ChatGPT. If its login expired');
    expect(consequence('grok')).toContain('could not authenticate with Grok.');
    expect(consequence('cursor')).toContain('could not authenticate with Cursor.');
    expect(consequence('pi')).toBe(
      "the helper could not authenticate with its provider. If its key expired, its owner can send `@candy /login` here, or run `beeline connect` on its machine.",
    );
  });

  it('keeps both sign-in remedies when a long name or handle leaves no room for the explanation', () => {
    const name = 'MoonScannerAI Research Assistant Prime';
    const handle = 'moonscannerai-research-assistant';
    const line = phraseTurnSilence(name, { kind: 'not-signed-in' }, {
      login: { handle, harness: 'codex' },
    });
    const text = `${name} ${line.verb} · ${line.consequence}`;
    expect(text.length).toBeLessThanOrEqual(TURN_SILENCE_LINE_MAX);
    expect(line.consequence).toBe(
      `Its owner can send \`@${handle} /login\` here, or run \`beeline connect\` on its machine.`,
    );
    expect(line.consequence).not.toContain('…');
  });

  it('never assigns the agent pronouns', () => {
    const kinds: ClassifiedTurnSilence[] = [
      { kind: 'hiccup', fault: 'the turn stalled' },
      { kind: 'wrong-model' },
      { kind: 'allowance-spent' },
      { kind: 'allowance-spent', allowanceUntil: 'Sep 19th, 2026 4:09 AM' },
      { kind: 'not-signed-in' },
      { kind: 'workspace-failure' },
      { kind: 'helper-out-of-date' },
      { kind: 'offline' },
      { kind: 'update-interrupted' },
    ];
    for (const kind of kinds) {
      const line = phraseTurnSilence('Candy', kind);
      expect(`${line.verb} · ${line.consequence}`).not.toMatch(
        /\b(she|she's|her|hers|herself|he|he's|him|his|himself)\b/i,
      );
    }
  });

  it('keeps the provider, not the model, as the allowance remedy', () => {
    const line = phraseTurnSilence('Candy', { kind: 'allowance-spent' });
    expect(line.consequence).toContain('Top up, or move the agent to another provider.');
    expect(line.consequence).not.toMatch(/model/i);
  });

  it('says so once when hiccup retries are exhausted', () => {
    expect(
      phraseTurnSilence(
        'Candy',
        { kind: 'hiccup', fault: 'ACP agent exited (code 1)' },
        { givingUp: true },
      ).consequence,
    ).toBe('ACP agent exited (code 1). Stopped retrying after three tries.');
  });

  it('does not promise a helper restart when none was authorized', () => {
    const line = phraseTurnSilence(
      'Candy',
      {
        kind: 'hiccup',
        fault: 'Command failed: git clone https://github.example/acme/widgets.git',
      },
      { restarting: false },
    );
    expect(line.consequence).toBe(
      'Command failed: git clone https://github.example/acme/widgets.git.',
    );
    expect(line.consequence).not.toMatch(/restarting|resending/i);
  });
});

describe('pending failed-command completion', () => {
  it('completes standing configuration and leaves transient clone recoverable', () => {
    expect(
      shouldCompletePendingFailedCommand(
        'workspace-failure',
        'corner parent Room repository state is not verified yet',
      ),
    ).toBe(true);
    expect(
      shouldCompletePendingFailedCommand(
        'workspace-failure',
        'Command failed: git clone https://github.example/acme/widgets.git',
      ),
    ).toBe(false);
    expect(shouldCompletePendingFailedCommand('hiccup', 'the turn stalled')).toBe(false);
    expect(shouldCompletePendingFailedCommand('update-interrupted')).toBe(false);
    expect(shouldCompletePendingFailedCommand('wrong-model')).toBe(true);
  });
});

describe('hiccup restart budget', () => {
  it('restarts the first two silences and gives up on the third', () => {
    expect(shouldRestartHiccup('hiccup', 1)).toBe(true);
    expect(shouldRestartHiccup('hiccup', 2)).toBe(true);
    expect(shouldRestartHiccup('hiccup', HICCUP_ATTEMPT_LIMIT)).toBe(false);
    expect(shouldRestartHiccup('wrong-model', 1)).toBe(false);
    expect(shouldRestartHiccup('allowance-spent', 1)).toBe(false);
    expect(shouldRestartHiccup('not-signed-in', 1)).toBe(false);
    expect(shouldRestartHiccup('workspace-failure', 1)).toBe(false);
  });
});
