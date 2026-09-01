import { describe, expect, it, vi } from 'vitest';
import {
  brass,
  collectConnectWizard,
  defaultConnectModel,
  requestConnectGrant,
  runConnectFinishCommand,
  type ConnectPrompts,
} from './connect-command.js';

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
  it('exchanges the app pairing code in one request without a browser ceremony', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            pairing_code: 'BUZZ-1234ABCD-5678EF90',
            agent_secret_key: '1'.repeat(64),
            agent_pubkey: '2'.repeat(64),
            body_secret_key: '3'.repeat(64),
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
        'buzz-1234abcd-5678ef90',
        { name: 'Scout', harness: 'codex', model: 'gpt-5.4', soul: 'Brisk and kind.' },
        fetchImpl as unknown as typeof fetch,
      ),
    ).resolves.toMatchObject({ workspace_name: 'Builders' });
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(fetchImpl.mock.calls[0]?.[0]).toBe('https://server.example/auth/agent/connect');
    expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body))).toEqual({
      pairing_code: 'BUZZ-1234ABCD-5678EF90',
      harness: 'codex',
      model: 'gpt-5.4',
      soul: 'Brisk and kind.',
      agent_name: 'Scout',
    });
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
        'BUZZ-1234ABCD-5678EF90',
        { name: 'Scout', harness: 'codex', model: 'gpt-5.4', soul: 'Brisk and kind.' },
        fetchImpl as unknown as typeof fetch,
      ),
    ).rejects.toThrow('pairing code has expired');
    expect(fetchImpl).toHaveBeenCalledOnce();
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
      collectConnectWizard(fixture.prompts, async () => ({
        currentValue: 'z-ai/glm-5.3-flash',
        options: [{ id: 'z-ai/glm-5.3-flash', name: 'GLM 5.3 Flash' }],
      })),
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
});
