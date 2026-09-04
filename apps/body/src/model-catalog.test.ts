import { describe, expect, it } from 'vitest';
import {
  fetchAgentModelCatalog,
  filterAgentModelCatalog,
  modelCatalogProbeEnvironment,
} from './model-catalog.js';
import type { AgentModelConfigOption } from './model-types.js';

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
      filterAgentModelCatalog(
        { kind: 'goose', command: 'goose', args: ['acp'] },
        raw,
        { OPENROUTER_API_KEY: 'secret' },
      ),
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
      filterAgentModelCatalog(
        { kind: 'pi', command: 'pi-acp', args: [] },
        raw,
        { OPENROUTER_API_KEY: 'secret' },
      )[0]?.options.map((option) => option.id),
    ).toEqual(['openrouter/native-model']);
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
});
