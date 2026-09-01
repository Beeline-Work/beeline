import { describe, expect, it } from 'vitest';
import {
  brass,
  collectConnectWizard,
  defaultConnectModel,
  presentDeviceApproval,
  runConnectFinishCommand,
  shouldOpenConnectBrowser,
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

  it('prints the approval link and code even when the browser opens', async () => {
    const messages: string[] = [];
    const opened: string[] = [];

    await presentDeviceApproval({
      verificationUri: 'https://server.usebeeline.app/auth/device/connect?user_code=BUZZ-1234',
      userCode: 'BUZZ-1234',
      env: { DISPLAY: ':0' },
      platform: 'linux',
      log: (message) => messages.push(message),
      open: async (url) => {
        opened.push(url);
      },
    });

    expect(messages).toEqual([
      'Approve this agent at: https://server.usebeeline.app/auth/device/connect?user_code=BUZZ-1234',
      'Code: BUZZ-1234',
    ]);
    expect(opened).toEqual([
      'https://server.usebeeline.app/auth/device/connect?user_code=BUZZ-1234',
    ]);
  });

  it('skips browser launch on a headless Linux or SSH session', async () => {
    const open = async () => {
      throw new Error('browser launch should not be attempted');
    };

    expect(shouldOpenConnectBrowser({}, 'linux')).toBe(false);
    expect(shouldOpenConnectBrowser({ DISPLAY: ':0', SSH_TTY: '/dev/pts/0' }, 'linux')).toBe(false);
    await expect(
      presentDeviceApproval({
        verificationUri: 'https://server.usebeeline.app/auth/device/connect?user_code=BUZZ-1234',
        userCode: 'BUZZ-1234',
        env: {},
        platform: 'linux',
        log: () => {},
        open,
      }),
    ).resolves.toBeUndefined();
  });

  it('refuses to write supervision state from the npm/worktree launcher', async () => {
    await expect(runConnectFinishCommand('/does/not/matter.json')).rejects.toThrow(
      /canonical installed Beeline launcher/,
    );
  });
});
