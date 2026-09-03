import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { completeDevicePairing } from './device-pairing.js';
import { identityFromKey } from './runtime.js';
import {
  brass,
  brassSpinner,
  collectConnectWizard,
  connectModelPickerFromAxes,
  connectPlainFailure,
  defaultConnectModel,
  requestConnectGrant,
  runConnectFinishCommand,
  type ConnectKeyStore,
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
    text: async (input) => next('text', input.message, input.initialValue),
    password: async (input) => next('password', input.message),
  };
  return { prompts, calls };
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
        { name: 'Scout', harness: 'codex', model: 'gpt-5.4', soul: 'Brisk and kind.' },
        fetchImpl as unknown as typeof fetch,
      ),
    ).resolves.toMatchObject({ workspace_name: 'Builders' });
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(fetchImpl.mock.calls[0]?.[0]).toBe('https://server.example/auth/agent/connect');
    expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body))).toEqual({
      pairing_code: '1234ABCD-5678EF90',
      harness: 'codex',
      model: 'gpt-5.4',
      soul: 'Brisk and kind.',
      avatar_seed: '4ed3aee3a46d2b0b3476472dbc77eafb',
      agent_name: 'Scout',
    });
  });

  it('derives the posted avatar seed from the pairing code deterministically', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 200 }));
    await requestConnectGrant(
      'https://server.example',
      '9999AAAA-1111BBBB',
      { name: 'Scout', harness: 'codex', model: 'gpt-5.4', soul: 'Brisk and kind.' },
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
      { name: 'Scout', harness: 'codex', model: 'gpt-5.4', soul: 'Brisk and kind.' },
      fetchImpl as unknown as typeof fetch,
    );
    expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body))).toMatchObject({
      soul: 'Brisk and kind.',
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
        { name: 'Scout', harness: 'codex', model: 'gpt-5.4', soul: 'Brisk and kind.' },
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
        { name: 'Scout', harness: 'codex', model: 'gpt-5.4', soul: 'Brisk and kind.' },
        fetchImpl as unknown as typeof fetch,
      ),
    ).toThrow('invalid pairing code');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('uses a harness-native provider without asking for credentials', async () => {
    const fixture = promptFixture(['codex', 'gpt-5.4', 'Scout', 'Brisk, practical, and kind.']);

    await expect(
      collectConnectWizard(fixture.prompts, async () => ({
        currentValue: 'gpt-5.4',
        options: [
          { id: 'gpt-5.4', name: 'GPT-5.4' },
          { id: 'gpt-5.6-sol', name: 'GPT-5.6-Sol' },
        ],
      })),
    ).resolves.toEqual({
      name: 'Scout',
      harness: 'codex',
      model: 'gpt-5.4',
      soul: 'Brisk, practical, and kind.',
    });
    expect(fixture.calls.map((call) => call.split(':', 1)[0])).toEqual([
      'select',
      'autocomplete',
      'text',
      'text',
    ]);
  });

  it('asks provider and API key for Pi with OpenRouter and GLM defaults', async () => {
    const fixture = promptFixture([
      'pi',
      'openrouter',
      'secret-key',
      'z-ai/glm-5.3-flash',
      'Piper',
      'Warm and incisive.',
    ]);

    await expect(
      collectConnectWizard(
        fixture.prompts,
        async () => ({
          currentValue: 'z-ai/glm-5.3-flash',
          options: [{ id: 'z-ai/glm-5.3-flash', name: 'GLM 5.3 Flash' }],
        }),
        { read: async () => undefined, save: async () => {} },
        process.env,
        async () => undefined,
      ),
    ).resolves.toEqual({
      name: 'Piper',
      harness: 'pi',
      provider: 'openrouter',
      apiKey: 'secret-key',
      model: 'z-ai/glm-5.3-flash',
      soul: 'Warm and incisive.',
    });
    expect(fixture.calls.map((call) => call.split(':', 1)[0])).toEqual([
      'select',
      'select',
      'password',
      'autocomplete',
      'text',
      'text',
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
      'Piper',
      'Warm and incisive.',
    ]);

    await expect(
      collectConnectWizard(
        fixture.prompts,
        async () => ({
          currentValue: 'z-ai/glm-5.3-flash',
          options: [{ id: 'z-ai/glm-5.3-flash', name: 'GLM 5.3 Flash' }],
        }),
        keyStore,
        process.env,
        async () => undefined,
      ),
    ).resolves.toEqual({
      name: 'Piper',
      harness: 'pi',
      provider: 'openrouter',
      apiKey: savedKey,
      model: 'z-ai/glm-5.3-flash',
      soul: 'Warm and incisive.',
    });
    expect(fixture.calls[2]).toContain('OpenRouter API key');
    expect(fixture.calls.every((call) => !call.includes(savedKey))).toBe(true);
    expect(fixture.calls.map((call) => call.split(':', 1)[0])).toEqual([
      'select',
      'select',
      'select',
      'autocomplete',
      'text',
      'text',
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
      'Piper',
      'Warm and incisive.',
    ]);

    await expect(
      collectConnectWizard(
        fixture.prompts,
        async () => ({
          currentValue: 'z-ai/glm-5.3-flash',
          options: [{ id: 'z-ai/glm-5.3-flash', name: 'GLM 5.3 Flash' }],
        }),
        keyStore,
        process.env,
        async () => undefined,
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
      'Piper',
      'Warm and incisive.',
    ]);

    await expect(
      collectConnectWizard(
        fixture.prompts,
        async () => ({
          currentValue: 'z-ai/glm-5.3-flash',
          options: [{ id: 'z-ai/glm-5.3-flash', name: 'GLM 5.3 Flash' }],
        }),
        keyStore,
        { OPENROUTER_API_KEY: 'sk-or-v1-envenvenvenv0' },
        async () => undefined,
      ),
    ).resolves.toMatchObject({ apiKey: 'sk-or-v1-envenvenvenv0' });
    expect(keyStore.save).not.toHaveBeenCalled();
  });

  it('uses brass color only when the terminal supports it', () => {
    const terminal = { isTTY: true } as NodeJS.WriteStream;
    expect(brass('Beeline', { COLORTERM: 'truecolor' }, terminal)).toContain('38;2;194;147;60');
    expect(brass('Beeline', { TERM: 'xterm-256color' }, terminal)).toContain('38;5;178');
    expect(brass('Beeline', { NO_COLOR: '1' }, terminal)).toBe('Beeline');
    expect(brass('Beeline', {}, { isTTY: false } as NodeJS.WriteStream)).toBe('Beeline');
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
        async () => ({ options: [{ id: 'gemini-2.5-pro' }] }),
        { read: async () => undefined, save: async () => {} },
        process.env,
        verifyKey as never,
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
      'z-ai/glm-5.3-flash',
      'goose',
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
