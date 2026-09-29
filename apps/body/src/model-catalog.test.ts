import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  fetchAgentModelCatalog,
  filterAgentModelCatalog,
  filterModelChoicesByLiveValidation,
  modelCatalogProbeEnvironment,
} from './model-catalog.js';
import type { AgentModelConfigOption } from './model-types.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('model catalog probe environment', () => {
  it('gives Goose a disposable profile instead of loading operator extensions', () => {
    expect(
      modelCatalogProbeEnvironment(
        { kind: 'goose', command: 'goose', args: ['acp'] },
        {
          OPENROUTER_API_KEY: 'secret',
          GOOSE_PROVIDER: 'openrouter',
          GOOSE_MODEL: 'z-ai/glm-5.3-flash',
          GOOSE_PATH_ROOT: '/operator/goose',
        },
        '/tmp/beeline-probe',
      ),
    ).toEqual({
      OPENROUTER_API_KEY: 'secret',
      GOOSE_PROVIDER: 'openrouter',
      GOOSE_MODEL: 'z-ai/glm-5.3-flash',
      GOOSE_PATH_ROOT: '/tmp/beeline-probe/goose',
    });
  });

  it('reads the operator profile when no provider was handed over', () => {
    // Connect's discovery probe asks exactly whether Goose already holds a
    // provider of its own. A disposable profile would answer "no" every time.
    const env = { HOME: '/operator/home' };
    expect(
      modelCatalogProbeEnvironment(
        { kind: 'goose', command: 'goose', args: ['acp'] },
        env,
        '/tmp/beeline-probe',
      ),
    ).toBe(env);
  });

  it('leaves every other harness environment unchanged', () => {
    const env = { HOME: '/operator/home' };
    expect(
      modelCatalogProbeEnvironment(
        { kind: 'pi', command: 'pi-acp', args: [] },
        env,
        '/tmp/beeline-probe',
      ),
    ).toBe(env);
  });
});

describe('agent model catalog filtering', () => {
  it('publishes the Fast mode axis only for Codex', () => {
    const axes: AgentModelConfigOption[] = [
      { id: 'fast-mode', category: 'model_config', options: [{ id: 'off' }, { id: 'on' }] },
    ];
    expect(
      filterAgentModelCatalog({ kind: 'codex', command: 'codex-acp', args: [] }, axes, {}),
    ).toEqual(axes);
    expect(
      filterAgentModelCatalog({ kind: 'claude', command: 'claude-acp', args: [] }, axes, {}),
    ).toEqual([]);
  });
  const raw: AgentModelConfigOption[] = [
    {
      id: 'model',
      category: 'model',
      currentValue: 'z-ai/glm-5.3-flash',
      options: [
        { id: 'z-ai/glm-5.3-flash' },
        { id: 'anthropic/claude-sonnet-4.5' },
        { id: 'openrouter/native-model' },
      ],
    },
    {
      id: 'mode',
      category: 'mode',
      currentValue: 'auto',
      options: [{ id: 'auto' }],
    },
  ];

  it('keeps Goose provider-routed model ids while still dropping the mode axis', () => {
    expect(
      filterAgentModelCatalog({ kind: 'goose', command: 'goose', args: ['acp'] }, raw, {
        OPENROUTER_API_KEY: 'secret',
      }),
    ).toEqual([
      {
        id: 'model',
        category: 'model',
        currentValue: 'z-ai/glm-5.3-flash',
        options: [
          { id: 'z-ai/glm-5.3-flash' },
          { id: 'anthropic/claude-sonnet-4.5' },
          { id: 'openrouter/native-model' },
        ],
      },
    ]);
  });

  it('keeps credential-prefix filtering for Pi catalogs', () => {
    expect(
      filterAgentModelCatalog({ kind: 'pi', command: 'pi-acp', args: [] }, raw, {
        OPENROUTER_API_KEY: 'secret',
      })[0]?.options.map((option) => option.id),
    ).toEqual(['openrouter/native-model']);
  });

  it('keeps OpenCode models whose credentials live in its own auth store', () => {
    expect(
      filterAgentModelCatalog(
        { kind: 'opencode', command: 'opencode', args: ['acp'] },
        raw,
        {},
      )[0]?.options.map((option) => option.id),
    ).toEqual(['z-ai/glm-5.3-flash', 'anthropic/claude-sonnet-4.5', 'openrouter/native-model']);
  });

  it('offers only model choices the live account accepts', async () => {
    const setConfigOption = async (_sessionId: string, _configId: string, value: string) => {
      if (value === 'claude-fable-5-1[1m]') throw new Error('model unavailable');
    };
    const filtered = await filterModelChoicesByLiveValidation(
      { setConfigOption, setModel: async () => undefined } as never,
      'session-1',
      [
        {
          id: 'model',
          category: 'model',
          options: [{ id: 'claude-sonnet-5' }, { id: 'claude-fable-5-1[1m]' }],
        },
      ],
    );
    expect(filtered[0]?.options).toEqual([{ id: 'claude-sonnet-5' }]);
  });

  it("publishes the selected live model's refreshed effort choices", async () => {
    const catalog: AgentModelConfigOption[] = [
      {
        id: 'model',
        category: 'model',
        currentValue: 'gpt-5.6-sol',
        options: [{ id: 'gpt-5.6-sol' }, { id: 'gpt-6-astra', name: 'GPT-6 Astra' }],
      },
      {
        id: 'reasoning_effort',
        category: 'thought_level',
        currentValue: 'medium',
        options: [{ id: 'low' }, { id: 'medium' }, { id: 'high' }],
      },
    ];
    const setConfigOption = async (_sessionId: string, _configId: string, value: string) => ({
      configOptions: [
        {
          id: 'model',
          category: 'model',
          currentValue: value,
          options: [{ value: 'gpt-5.6-sol' }, { value: 'gpt-6-astra', name: 'GPT-6 Astra' }],
        },
        {
          id: 'reasoning_effort',
          category: 'thought_level',
          currentValue: value === 'gpt-6-astra' ? 'high' : 'medium',
          options:
            value === 'gpt-6-astra'
              ? [{ value: 'high' }, { value: 'xhigh' }]
              : [{ value: 'low' }, { value: 'medium' }, { value: 'high' }],
        },
      ],
    });

    const filtered = await filterModelChoicesByLiveValidation(
      { setConfigOption, setModel: async () => undefined } as never,
      'restart-session',
      catalog,
      'gpt-6-astra',
    );

    expect(filtered.find((axis) => axis.category === 'thought_level')?.options).toEqual([
      { id: 'high' },
      { id: 'xhigh' },
    ]);
    expect(filtered.find((axis) => axis.category === 'model')?.options).toEqual(
      catalog[0]?.options,
    );
  });
});

describe('bounded catalog probe', () => {
  it('gives up on a harness that never answers instead of waiting out the default', async () => {
    const started = Date.now();
    await expect(
      fetchAgentModelCatalog(
        // A process that reads stdin and answers nothing: the ACP handshake
        // can only end at the deadline.
        { command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'] },
        {},
        undefined,
        { timeoutMs: 250 },
      ),
    ).rejects.toThrow(/timed out/i);
    // The default is 60s per request; the bound is what ends this one.
    expect(Date.now() - started).toBeLessThan(15_000);
  });

  it('bounds the live per-model validation pass, not just the handshake', async () => {
    // A harness that answers the handshake instantly but never answers
    // `session/set_config_option` — connect's discovery probe validates every
    // advertised model through that call before offering it (`fetchAgentModelCatalog`
    // -> `filterModelChoicesByLiveValidation`), each with its own 60s default
    // timeout. A `timeoutMs` passed to the probe is documented as a "whole-read
    // deadline", but only bounded the handshake: three unanswered models used
    // to cost up to 180s (or hang forever) instead of failing at the deadline.
    const directory = await mkdtemp(resolve(tmpdir(), 'beeline-catalog-probe-'));
    temporaryDirectories.push(directory);
    const script = resolve(directory, 'silent-setter-agent.mjs');
    await writeFile(
      script,
      `#!/usr/bin/env node
import { createInterface } from 'node:readline';
const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') {
    send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: 1 } });
  } else if (message.method === 'session/new') {
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        sessionId: 'session-1',
        configOptions: [
          {
            id: 'model',
            category: 'model',
            currentValue: 'model-a',
            options: [{ id: 'model-a' }, { id: 'model-b' }, { id: 'model-c' }],
          },
        ],
      },
    });
  }
  // session/set_config_option: never answered.
});
`,
    );
    const started = Date.now();
    await expect(
      fetchAgentModelCatalog(
        { command: process.execPath, args: [script] },
        {},
        undefined,
        { timeoutMs: 500 },
      ),
    ).rejects.toThrow(/timed out/i);
    // Three unanswered setter calls at the 60s-per-request default would take
    // 180s; the whole-read deadline is what must end this one instead.
    expect(Date.now() - started).toBeLessThan(15_000);
  });
});
