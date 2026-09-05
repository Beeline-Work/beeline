import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { completeDevicePairing } from './device-pairing.js';
import { identityFromKey } from './runtime.js';
import type { DetectedAgentCommand } from './agent-command.js';
import {
  brass,
  brassRails,
  brassSpinner,
  collectConnectWizard,
  connectFoundLine,
  connectProbeFoundModels,
  soleInstalledConnectHarness,
  CONNECT_PROBE_TIMEOUT_MS,
  confirmSeededName,
  finishConnectedAgentPairing,
  renameConnectedAgent,
  seededIdentityLine,
  connectModelPickerFromAxes,
  connectPlainFailure,
  defaultConnectModel,
  parseConnectSubscriptions,
  requestConnectGrant,
  runConnectFinishCommand,
  type ConnectKeyStore,
  type ConnectModelCatalogRequest,
  type ConnectPrompts,
} from './connect-command.js';

const spinner = vi.hoisted(() => ({
  start: vi.fn(),
  stop: vi.fn(),
}));

vi.mock('@clack/prompts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@clack/prompts')>()),
  spinner: vi.fn(() => spinner),
}));

function promptFixture(answers: string[]) {
  const calls: string[] = [];
  let offset = 0;
  const next = (kind: string, message: string, initialValue?: string): string => {
    calls.push(`${kind}:${message}:${initialValue ?? ''}`);
    const answer = answers[offset++];
    if (answer === undefined) throw new Error(`missing ${kind} answer`);
    return answer;
  };
  const prompts: ConnectPrompts = {
    select: async (input) => next('select', input.message, input.initialValue) as never,
    autocomplete: async (input) => next('autocomplete', input.message, input.initialValue) as never,
    text: async (input) => {
      const answer = next('text', input.message, input.initialValue);
      const complaint = input.validate?.(answer);
      if (complaint) throw new Error(complaint);
      return answer;
    },
    password: async (input) => next('password', input.message),
  };
  return { prompts, calls };
}

/** Supported harnesses this machine is pretending to have installed. */
function installed(...kinds: Array<'codex' | 'claude' | 'goose' | 'pi' | 'grok'>) {
  return () =>
    kinds.map(
      (kind) =>
        ({
          kind,
          status: 'ready',
          agent: { kind, command: kind, args: [] },
        }) as DetectedAgentCommand,
    );
}

/**
 * The one catalog seam the wizard has, answering as a real harness does: the
 * discovery probe arrives with no key, the credentialed read arrives with one.
 * A harness with no `configured` catalog is one that cannot answer unasked.
 */
function catalogSeam(input: {
  configured?: { currentValue?: string; options: Array<{ id: string; name?: string }> };
  credentialed?: { currentValue?: string; options: Array<{ id: string; name?: string }>; note?: string };
  probeFailure?: Error;
}) {
  const requests: ConnectModelCatalogRequest[] = [];
  const load = async (request: ConnectModelCatalogRequest) => {
    requests.push(request);
    if (request.apiKey) {
      if (!input.credentialed) throw new Error('no credentialed catalog in this fixture');
      return input.credentialed;
    }
    if (input.probeFailure) throw input.probeFailure;
    if (!input.configured) throw new Error('goose is not configured');
    return input.configured;
  };
  return { load, requests };
}

describe('connect wizard', () => {
  it('labels each completed spinner with what the step accomplished', async () => {
    spinner.start.mockClear();
    spinner.stop.mockClear();

    await brassSpinner(
      'Connecting to your Beeline Workspace…',
      async () => ({ workspace_name: 'Builders' }),
      (grant) => `Connected to ${grant.workspace_name}`,
    );
    await brassSpinner(
      'Installing the Beeline daemon…',
      async () => ({ version: '0.0.5' }),
      (release) => `Installed Beeline helper ${release.version}`,
    );
    await brassSpinner(
      'Starting your agent…',
      async () => ({ agent_name: 'Scout' }),
      (grant) => `Started ${grant.agent_name}`,
    );

    expect(spinner.start.mock.calls).toEqual([
      ['Connecting to your Beeline Workspace…'],
      ['Installing the Beeline daemon…'],
      ['Starting your agent…'],
    ]);
    expect(spinner.stop.mock.calls).toEqual([
      ['Connected to Builders'],
      ['Installed Beeline helper 0.0.5'],
      ['Started Scout'],
    ]);
    expect(spinner.stop).not.toHaveBeenCalledWith('Done');
  });

  it('passes a prefix-free app pairing code through in one request without a browser ceremony', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            agent_secret_key: '1'.repeat(64),
            agent_pubkey: '2'.repeat(64),
            body_secret_key: '3'.repeat(64),
            daemon_exchange_token: `bde_${'5'.repeat(43)}`,
            agent_name: 'Scout',
            workspace_id: 'workspace-id',
            workspace_name: 'Builders',
            paired_by: '4'.repeat(64),
            harness: 'codex',
            model: 'gpt-5.4',
            soul: 'Brisk and kind.',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    );

    await expect(
      requestConnectGrant(
        'https://server.example',
        '1234abcd-5678ef90',
        { harness: 'codex', model: 'gpt-5.4' },
        fetchImpl as unknown as typeof fetch,
      ),
    ).resolves.toMatchObject({ workspace_name: 'Builders' });
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(fetchImpl.mock.calls[0]?.[0]).toBe('https://server.example/auth/agent/connect');
    // The wizard sends neither a name nor a soul: the server seeds both.
    expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body))).toEqual({
      pairing_code: '1234ABCD-5678EF90',
      harness: 'codex',
      model: 'gpt-5.4',
      avatar_seed: '4ed3aee3a46d2b0b3476472dbc77eafb',
    });
  });

  it('finish sends the event kinds --subscribe named, and nothing when it was not given', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 200 }));
    await finishConnectedAgentPairing(
      'https://server.example',
      '1234abcd-5678ef90',
      true,
      ['joined'],
      fetchImpl as unknown as typeof fetch,
    );
    expect(fetchImpl.mock.calls[0]?.[0]).toBe('https://server.example/auth/agent/connect/finish');
    expect(
      (JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body)) as Record<string, unknown>)
        .event_subscriptions,
    ).toEqual(['joined']);
    await finishConnectedAgentPairing(
      'https://server.example',
      '1234abcd-5678ef90',
      true,
      [],
      fetchImpl as unknown as typeof fetch,
    );
    expect(
      JSON.parse(String(fetchImpl.mock.calls[1]?.[1]?.body)) as Record<string, unknown>,
    ).not.toHaveProperty('event_subscriptions');
  });

  it('reads --subscribe as a comma-separated list, deduped and trimmed', () => {
    expect(parseConnectSubscriptions('joined, check-failed ,JOINED')).toEqual([
      'joined',
      'check-failed',
    ]);
    expect(parseConnectSubscriptions('')).toEqual([]);
    expect(parseConnectSubscriptions(undefined)).toEqual([]);
  });

  it('derives the posted avatar seed from the pairing code deterministically', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 200 }));
    await requestConnectGrant(
      'https://server.example',
      '9999AAAA-1111BBBB',
      { harness: 'codex', model: 'gpt-5.4' },
      fetchImpl as unknown as typeof fetch,
    );
    const body = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body)) as {
      avatar_seed?: string;
    };
    const first = body.avatar_seed;
    fetchImpl.mockClear();
    await requestConnectGrant(
      'https://server.example',
      '9999AAAA-1111BBBB',
      { harness: 'codex', model: 'gpt-5.4' },
      fetchImpl as unknown as typeof fetch,
    );
    expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body))).toMatchObject({
      avatar_seed: first,
    });
    expect(first).toMatch(/^[0-9a-f]{32}$/);
  });

  it('surfaces a claimed or expired pairing code as one server message', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ message: 'pairing code has expired' }), {
          status: 410,
          headers: { 'content-type': 'application/json' },
        }),
    );
    await expect(
      requestConnectGrant(
        'https://server.example',
        '1234ABCD-5678EF90',
        { harness: 'codex', model: 'gpt-5.4' },
        fetchImpl as unknown as typeof fetch,
      ),
    ).rejects.toThrow('pairing code has expired');
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('rejects an invalid pairing code before making a connection request', async () => {
    const fetchImpl = vi.fn();
    expect(() =>
      requestConnectGrant(
        'https://server.example',
        'not-a-pairing-code',
        { harness: 'codex', model: 'gpt-5.4' },
        fetchImpl as unknown as typeof fetch,
      ),
    ).toThrow('invalid pairing code');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('uses a harness-native provider without asking for credentials', async () => {
    const fixture = promptFixture(['codex', 'gpt-5.4']);
    // Several harnesses installed, and this one names no current model: the
    // harness and the model are the two questions the machine cannot answer.
    const seam = catalogSeam({
      configured: {
        options: [
          { id: 'gpt-5.4', name: 'GPT-5.4' },
          { id: 'gpt-5.6-sol', name: 'GPT-5.6-Sol' },
        ],
      },
    });

    await expect(
      collectConnectWizard(
        fixture.prompts,
        seam.load,
        { read: async () => undefined, save: async () => {} },
        process.env,
        async () => undefined,
        { detect: installed('codex', 'claude'), announce: () => {} },
      ),
    ).resolves.toEqual({ harness: 'codex', model: 'gpt-5.4' });
    // Two questions, and neither is a name or a soul.
    expect(fixture.calls.map((call) => call.split(':', 1)[0])).toEqual(['select', 'autocomplete']);
    expect(fixture.calls.some((call) => /Agent name|soul/i.test(call))).toBe(false);
  });

  it('skips provider, key and model for a Goose that already holds a provider', async () => {
    const fixture = promptFixture([]);
    const announced: string[] = [];
    const seam = catalogSeam({
      configured: {
        currentValue: 'anthropic/claude-sonnet-4.5',
        options: [{ id: 'anthropic/claude-sonnet-4.5' }, { id: 'x-ai/grok-code-fast-1' }],
      },
    });
    const keyStore: ConnectKeyStore = { read: vi.fn(), save: vi.fn() };
    const verifyKey = vi.fn();

    await expect(
      collectConnectWizard(
        fixture.prompts,
        seam.load,
        keyStore,
        { OPENROUTER_API_KEY: 'sk-or-v1-envenvenvenv0' },
        verifyKey as never,
        { detect: installed('goose'), announce: (line) => announced.push(line) },
      ),
    ).resolves.toEqual({ harness: 'goose', model: 'anthropic/claude-sonnet-4.5' });
    // Nothing was asked at all: harness, provider, key and model were all facts.
    expect(fixture.calls).toEqual([]);
    expect(keyStore.read).not.toHaveBeenCalled();
    expect(verifyKey).not.toHaveBeenCalled();
    expect(announced).toEqual([
      'Goose is the only harness installed here, and it is already set up, running anthropic/claude-sonnet-4.5.',
    ]);
    // One bounded attempt, and no credentialed second read.
    expect(seam.requests).toEqual([{ harness: 'goose', timeoutMs: CONNECT_PROBE_TIMEOUT_MS }]);
  });

  it('gives an unconfigured Goose the whole provider, key and model flow', async () => {
    const fixture = promptFixture(['goose', 'openrouter', 'sk-or-v1-freshfreshfresh7', 'z-ai/glm-5.3-flash']);
    const announced: string[] = [];
    const keyStore: ConnectKeyStore = { read: vi.fn(async () => undefined), save: vi.fn(async () => {}) };
    const seam = catalogSeam({
      credentialed: {
        currentValue: 'z-ai/glm-5.3-flash',
        options: [{ id: 'z-ai/glm-5.3-flash', name: 'GLM 5.3 Flash' }],
      },
    });

    await expect(
      collectConnectWizard(
        fixture.prompts,
        seam.load,
        keyStore,
        {},
        async () => undefined,
        { detect: installed('goose'), announce: (line) => announced.push(line) },
      ),
    ).resolves.toEqual({
      harness: 'goose',
      provider: 'openrouter',
      apiKey: 'sk-or-v1-freshfreshfresh7',
      model: 'z-ai/glm-5.3-flash',
    });
    // The sole installed harness failed its probe, so the list is offered
    // rather than assumed, and nothing is announced as found.
    expect(fixture.calls.map((call) => call.split(':', 1)[0])).toEqual([
      'select',
      'select',
      'password',
      'autocomplete',
    ]);
    expect(announced).toEqual([]);
    expect(keyStore.save).toHaveBeenCalledWith('openrouter', 'sk-or-v1-freshfreshfresh7');
    // Picking the harness that already failed does not buy a second attempt.
    expect(seam.requests.filter((request) => request.timeoutMs !== undefined)).toHaveLength(1);
  });

  it('falls back to asking when the probe times out, without a second attempt', async () => {
    const fixture = promptFixture(['goose', 'openrouter', 'sk-or-v1-freshfreshfresh7', 'z-ai/glm-5.3-flash']);
    const seam = catalogSeam({
      probeFailure: new Error('ACP session/new timed out after 12000ms'),
      credentialed: {
        currentValue: 'z-ai/glm-5.3-flash',
        options: [{ id: 'z-ai/glm-5.3-flash', name: 'GLM 5.3 Flash' }],
      },
    });

    await expect(
      collectConnectWizard(
        fixture.prompts,
        seam.load,
        { read: async () => undefined, save: async () => {} },
        {},
        async () => undefined,
        { detect: installed('goose'), announce: () => {} },
      ),
    ).resolves.toMatchObject({ harness: 'goose', model: 'z-ai/glm-5.3-flash' });
    expect(fixture.calls.map((call) => call.split(':', 1)[0])).toEqual([
      'select',
      'select',
      'password',
      'autocomplete',
    ]);
    // The wizard bounded its one attempt and then asked instead of waiting.
    expect(seam.requests[0]).toEqual({ harness: 'goose', timeoutMs: CONNECT_PROBE_TIMEOUT_MS });
    expect(seam.requests.filter((request) => request.timeoutMs !== undefined)).toHaveLength(1);
  }, 5_000);

  it('offers the list when several harnesses are installed, and probes only the one picked', async () => {
    const fixture = promptFixture(['claude']);
    const announced: string[] = [];
    const seam = catalogSeam({
      configured: { currentValue: 'claude-opus-4-1', options: [{ id: 'claude-opus-4-1' }] },
    });

    await expect(
      collectConnectWizard(
        fixture.prompts,
        seam.load,
        { read: async () => undefined, save: async () => {} },
        {},
        async () => undefined,
        { detect: installed('codex', 'claude', 'goose'), announce: (line) => announced.push(line) },
      ),
    ).resolves.toEqual({ harness: 'claude', model: 'claude-opus-4-1' });
    expect(fixture.calls).toHaveLength(1);
    expect(fixture.calls[0]).toContain('Choose harness');
    expect(seam.requests).toEqual([{ harness: 'claude', timeoutMs: CONNECT_PROBE_TIMEOUT_MS }]);
    expect(announced).toEqual(['Claude is already set up, running claude-opus-4-1.']);
  });

  it('reads a probe as evidence only when the harness enumerated models itself', () => {
    expect(connectProbeFoundModels({ options: [{ id: 'gpt-5.4' }] })).toBe(true);
    expect(connectProbeFoundModels({ options: [] })).toBe(false);
    // The synthesised provider default is exactly what must not pass for one.
    expect(
      connectProbeFoundModels({
        currentValue: 'z-ai/glm-5.3-flash',
        options: [{ id: 'z-ai/glm-5.3-flash' }],
        note: 'goose did not enumerate models; offering the provider default',
      }),
    ).toBe(false);
  });

  it('auto-selects only the single installed harness', () => {
    expect(soleInstalledConnectHarness(installed('goose')())).toBe('goose');
    expect(soleInstalledConnectHarness(installed('goose', 'pi')())).toBeUndefined();
    expect(soleInstalledConnectHarness([])).toBeUndefined();
    expect(
      soleInstalledConnectHarness([
        { kind: 'pi', status: 'missing-adapter', install: { command: 'npm', args: ['install', '-g', 'pi-acp'] } },
      ]),
    ).toBeUndefined();
    expect(connectFoundLine({ harness: 'pi', sole: false })).toBe('Pi is already set up.');
  });

  it('asks provider and API key for Pi with OpenRouter and GLM defaults', async () => {
    const fixture = promptFixture([
      'pi',
      'openrouter',
      'secret-key',
      'z-ai/glm-5.3-flash',
    ]);

    await expect(
      collectConnectWizard(
        fixture.prompts,
        catalogSeam({
          credentialed: {
            currentValue: 'z-ai/glm-5.3-flash',
            options: [{ id: 'z-ai/glm-5.3-flash', name: 'GLM 5.3 Flash' }],
          },
        }).load,
        { read: async () => undefined, save: async () => {} },
        process.env,
        async () => undefined,
        { detect: installed('pi', 'goose'), announce: () => {} },
      ),
    ).resolves.toEqual({
      harness: 'pi',
      provider: 'openrouter',
      apiKey: 'secret-key',
      model: 'z-ai/glm-5.3-flash',
    });
    expect(fixture.calls.map((call) => call.split(':', 1)[0])).toEqual([
      'select',
      'select',
      'password',
      'autocomplete',
    ]);
    expect(fixture.calls[1]).toContain(':openrouter');
    expect(fixture.calls[3]).toContain(':z-ai/glm-5.3-flash');
    expect(defaultConnectModel('goose', 'openrouter')).toBe('z-ai/glm-5.3-flash');
  });

  it('offers the saved OpenRouter key as the default instead of re-asking', async () => {
    const savedKey = 'sk-or-v1-abcdefghijklmn123';
    const keyStore: ConnectKeyStore = {
      read: vi.fn(async () => savedKey),
      save: vi.fn(async () => {}),
    };
    const fixture = promptFixture([
      'pi',
      'openrouter',
      'saved',
      'z-ai/glm-5.3-flash',
    ]);

    await expect(
      collectConnectWizard(
        fixture.prompts,
        catalogSeam({
          credentialed: {
            currentValue: 'z-ai/glm-5.3-flash',
            options: [{ id: 'z-ai/glm-5.3-flash', name: 'GLM 5.3 Flash' }],
          },
        }).load,
        keyStore,
        process.env,
        async () => undefined,
        { detect: installed('pi', 'goose'), announce: () => {} },
      ),
    ).resolves.toEqual({
      harness: 'pi',
      provider: 'openrouter',
      apiKey: savedKey,
      model: 'z-ai/glm-5.3-flash',
    });
    expect(fixture.calls[2]).toContain('OpenRouter API key');
    expect(fixture.calls.every((call) => !call.includes(savedKey))).toBe(true);
    expect(fixture.calls.map((call) => call.split(':', 1)[0])).toEqual([
      'select',
      'select',
      'select',
      'autocomplete',
    ]);
    expect(keyStore.save).not.toHaveBeenCalled();
  });

  it('replaces the stored key when the user enters a new one', async () => {
    const keyStore: ConnectKeyStore = {
      read: vi.fn(async () => 'sk-or-v1-oldoldoldoldold99'),
      save: vi.fn(async () => {}),
    };
    const fixture = promptFixture([
      'pi',
      'openrouter',
      'new',
      'sk-or-v1-freshfreshfresh7',
      'z-ai/glm-5.3-flash',
    ]);

    await expect(
      collectConnectWizard(
        fixture.prompts,
        catalogSeam({
          credentialed: {
            currentValue: 'z-ai/glm-5.3-flash',
            options: [{ id: 'z-ai/glm-5.3-flash', name: 'GLM 5.3 Flash' }],
          },
        }).load,
        keyStore,
        process.env,
        async () => undefined,
        { detect: installed('pi', 'goose'), announce: () => {} },
      ),
    ).resolves.toMatchObject({ apiKey: 'sk-or-v1-freshfreshfresh7' });
    expect(keyStore.save).toHaveBeenCalledWith('openrouter', 'sk-or-v1-freshfreshfresh7');
  });

  it('falls back to an environment key without storing it', async () => {
    const keyStore: ConnectKeyStore = {
      read: vi.fn(async () => undefined),
      save: vi.fn(async () => {}),
    };
    const fixture = promptFixture([
      'pi',
      'openrouter',
      'saved',
      'z-ai/glm-5.3-flash',
    ]);

    await expect(
      collectConnectWizard(
        fixture.prompts,
        catalogSeam({
          credentialed: {
            currentValue: 'z-ai/glm-5.3-flash',
            options: [{ id: 'z-ai/glm-5.3-flash', name: 'GLM 5.3 Flash' }],
          },
        }).load,
        keyStore,
        { OPENROUTER_API_KEY: 'sk-or-v1-envenvenvenv0' },
        async () => undefined,
        { detect: installed('pi', 'goose'), announce: () => {} },
      ),
    ).resolves.toMatchObject({ apiKey: 'sk-or-v1-envenvenvenv0' });
    expect(keyStore.save).not.toHaveBeenCalled();
  });

  it('uses brass color only when the terminal supports it', () => {
    const terminal = { isTTY: true } as NodeJS.WriteStream;
    // Brand brass #D7AF5F, which is xterm 179 exactly.
    expect(brass('Beeline', { COLORTERM: 'truecolor' }, terminal)).toContain('38;2;215;175;95');
    expect(brass('Beeline', { TERM: 'xterm-256color' }, terminal)).toContain('38;5;179');
    expect(brass('Beeline', { NO_COLOR: '1' }, terminal)).toBe('Beeline');
    expect(brass('Beeline', {}, { isTTY: false } as NodeJS.WriteStream)).toBe('Beeline');
  });

  it('names the seeded identity in one line with its animal', () => {
    expect(seededIdentityLine({ agent_name: 'Foxy', agent_face: 'fox' })).toBe('Foxy the fox');
    expect(seededIdentityLine({ agent_name: 'Foxy' })).toBe('Foxy');
  });

  it('accepts the seeded name on one key without asking for anything else', async () => {
    const fixture = promptFixture(['keep']);
    const fetchImpl = vi.fn();
    await expect(
      confirmSeededName(
        'https://server.example',
        '1234ABCD-5678EF90',
        { agent_name: 'Foxy', agent_face: 'fox' },
        fetchImpl as unknown as typeof fetch,
        fixture.prompts,
      ),
    ).resolves.toBe('Foxy');
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(fixture.calls.map((call) => call.split(':', 1)[0])).toEqual(['select']);
  });

  it('renames on the other key, through the pairing code', async () => {
    const fixture = promptFixture(['rename', 'Bramble']);
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ agent_name: 'Bramble' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    await expect(
      confirmSeededName(
        'https://server.example',
        '1234abcd-5678ef90',
        { agent_name: 'Foxy', agent_face: 'fox' },
        fetchImpl as unknown as typeof fetch,
        fixture.prompts,
      ),
    ).resolves.toBe('Bramble');
    expect(fetchImpl.mock.calls[0]?.[0]).toBe('https://server.example/auth/agent/connect/name');
    expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body))).toEqual({
      pairing_code: '1234ABCD-5678EF90',
      agent_name: 'Bramble',
    });
  });

  it('keeps the seeded name rather than losing a live connection to a failed rename', async () => {
    const fixture = promptFixture(['rename', 'Bramble']);
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 503 }));
    await expect(
      confirmSeededName(
        'https://server.example',
        '1234ABCD-5678EF90',
        { agent_name: 'Foxy', agent_face: 'fox' },
        fetchImpl as unknown as typeof fetch,
        fixture.prompts,
      ),
    ).resolves.toBe('Foxy');
  });

  it('rejects an unusable rename before making a request', async () => {
    const fixture = promptFixture(['rename', 'rm -rf /']);
    const fetchImpl = vi.fn();
    await expect(
      confirmSeededName(
        'https://server.example',
        '1234ABCD-5678EF90',
        { agent_name: 'Foxy' },
        fetchImpl as unknown as typeof fetch,
        fixture.prompts,
      ),
    ).rejects.toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('repaints the clack rails brass, leaving every other colour alone', () => {
    const terminal = { isTTY: true } as NodeJS.WriteStream;
    const painted = brassRails(
      '\u001b[36m\u25c6\u001b[39m  \u001b[32mok\u001b[39m',
      { COLORTERM: 'truecolor' },
      terminal,
    );
    expect(painted).toContain('38;2;215;175;95');
    expect(painted).not.toContain('[36m');
    expect(painted).toContain('\u001b[32mok');
    expect(brassRails('\u001b[36m\u25c6', { NO_COLOR: '1' }, terminal)).toContain('[36m');
  });

  it('refuses to write supervision state from the npm/worktree launcher', async () => {
    await expect(runConnectFinishCommand('/does/not/matter.json')).rejects.toThrow(
      /canonical installed Beeline launcher/,
    );
  });

  it('rolls back the pairing when the wizard fails before the helper starts', async () => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 204 }));
    const grant = {
      agentSecretKey: '1'.repeat(64),
      bodySecretKey: '3'.repeat(64),
      agentName: 'Scout',
      harness: 'codex' as const,
      model: 'gpt-5.4',
      soul: 'Brisk and kind.',
      workspaceId: 'workspace-id',
      workspaceName: 'Builders',
      pairedBy: '4'.repeat(64),
      monolithBaseUrl: 'https://server.example',
      daemonExchangeToken: `bde_${'5'.repeat(43)}`,
    };
    await expect(
      completeDevicePairing(grant, {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        selectedAgent: { kind: 'codex', command: 'codex', args: [] },
        localConfig: { agentBinary: 'codex', mcpBinary: 'buzz-dev-mcp', agentEnv: {} },
        validateSelection: async () => {
          throw new Error('model unavailable for this harness');
        },
      }),
    ).rejects.toThrow('model unavailable for this harness');
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe(
      'https://server.example/v1/auth/daemon/rollback',
    );
    expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body))).toEqual({
      exchangeToken: grant.daemonExchangeToken,
    });
  });

  it('completes pairing without contacting the rollback endpoint', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            daemonToken: `bdt_${'a'.repeat(43)}`,
            agentId: identityFromKey('1'.repeat(64), 'Scout').publicKey,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    );
    const supervisorRoot = await mkdtemp(join(tmpdir(), 'beeline-pair-'));
    try {
      await completeDevicePairing(
        {
          agentSecretKey: '1'.repeat(64),          bodySecretKey: '3'.repeat(64),
          agentName: 'Scout',
          harness: 'codex',
          model: 'gpt-5.4',
          soul: 'Brisk and kind.',
          workspaceId: 'workspace-id',
          workspaceName: 'Builders',
          pairedBy: '4'.repeat(64),
          monolithBaseUrl: 'https://server.example',
          daemonExchangeToken: `bde_${'5'.repeat(43)}`,
        },
        {
          fetchImpl: fetchImpl as unknown as typeof fetch,
          supervisorRoot,
          selectedAgent: { kind: 'codex', command: 'codex', args: [] },
          localConfig: { agentBinary: 'codex', mcpBinary: 'buzz-dev-mcp', agentEnv: {} },
          validateSelection: async () => undefined,
          launch: async () => 4242,
        },
      );
      expect(fetchImpl.mock.calls.map((call) => String(call[0]))).not.toContain(
        'https://server.example/v1/auth/daemon/rollback',
      );
    } finally {
      await rm(supervisorRoot, { recursive: true, force: true });
    }
  });

  it('verifies a provider key right after the key step and aborts with the provider sentence', async () => {
    const fixture = promptFixture(['goose', 'google', 'b', 'Gemini', 'Bright.']);
    const verifyKey = vi.fn(async (input: { provider: string; apiKey: string }) => {
      throw new Error('Google rejected the key (400).');
    });
    await expect(
      collectConnectWizard(
        fixture.prompts,
        catalogSeam({ credentialed: { options: [{ id: 'gemini-2.5-pro' }] } }).load,
        { read: async () => undefined, save: async () => {} },
        process.env,
        verifyKey as never,
        { detect: installed('goose', 'pi'), announce: () => {} },
      ),
    ).rejects.toThrow('Google rejected the key (400).');
    expect(verifyKey).toHaveBeenCalledWith({ provider: 'google', apiKey: 'b' });
    // The catalog step is never reached with an unverified key.
    expect(fixture.calls.map((call) => call.split(':', 1)[0])).toEqual([
      'select',
      'select',
      'password',
    ]);
  });

  it('keeps goose model picking alive when the credential filter empties the catalog', () => {
    // goose advertises a provider-agnostic builtin list it routes through the
    // configured provider; the credential filter (held: openrouter) keeps only
    // `openrouter/…` ids, so the filtered axis is empty. The raw axis must win.
    const picker = connectModelPickerFromAxes(
      [{ category: 'model', currentValue: 'z-ai/glm-5.3-flash', options: [] }],
      'z-ai/glm-5.3-flash',
      'goose',
      [
        {
          category: 'model',
          currentValue: 'z-ai/glm-5.3-flash',
          options: [
            { id: 'z-ai/glm-5.3-flash' },
            { id: 'anthropic/claude-opus-4.1' },
            { id: 'google/gemini-2.5-pro' },
          ],
        },
        { category: 'thought_level', currentValue: 'off', options: [{ id: 'off' }] },
      ],
    );
    expect(picker.options.map((option) => option.id)).toEqual([
      'z-ai/glm-5.3-flash',
      'anthropic/claude-opus-4.1',
      'google/gemini-2.5-pro',
    ]);
    expect(picker.currentValue).toBe('z-ai/glm-5.3-flash');
    expect(picker.note).toBeUndefined();
  });

  it('falls back to the provider default model with a note when a harness enumerates nothing', () => {
    const picker = connectModelPickerFromAxes(
      [{ category: 'model', options: [] }],
      'z-ai/glm-5.3-flash',
      'goose',
    );
    expect(picker).toEqual({
      currentValue: 'z-ai/glm-5.3-flash',
      options: [{ id: 'z-ai/glm-5.3-flash' }],
      note: 'goose did not enumerate models; offering the provider default',
    });
  });

  it('collapses any connect finish failure into one plain sentence without a stack', () => {
    const stacked = Object.assign(
      new Error(
        'model "gemini-2.5-pro" is unavailable. Choose one of the values in the live harness catalog.\n'
          + '    at applyAgentModelSelection (model-config.ts:501)\n'
          + '    at completeDevicePairing (device-pairing.ts:68)',
      ),
      { name: 'ModelSelectionUnavailableError' },
    );
    expect(connectPlainFailure(stacked)).toBe(
      'Connecting your agent failed: model "gemini-2.5-pro" is unavailable. Choose one of the values in the live harness catalog.',
    );
    expect(connectPlainFailure('boom')).toBe('Connecting your agent failed: boom');
  });
});
