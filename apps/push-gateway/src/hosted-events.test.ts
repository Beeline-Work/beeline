import { describe, expect, it, vi } from 'vitest';
import type { EventsServiceConfig } from '@beeline/body/events-service';
import { RepositoryEventsState } from '@beeline/body/events-state';
import { startHostedRepositoryEvents } from './hosted-events.js';

const config: EventsServiceConfig = {
  supervisorRoot: '/runtime',
  stateFile: '/legacy/events.json',
  identityFile: '/identity/events.json',
  githubAppId: '1',
  githubPrivateKey: 'private-key',
};

describe('hosted repository-events consumer', () => {
  it('joins materializer readiness without acquiring the retired process lock', async () => {
    const state = new RepositoryEventsState({
      load: async () => undefined,
      save: async () => undefined,
    });
    const run = vi.fn(async (_config, options) => {
      await options.notifier!.ready('ready; repos=0');
      await new Promise<void>((resolve) =>
        options.signal!.addEventListener('abort', () => resolve()),
      );
    });
    const controller = new AbortController();

    const hosted = await startHostedRepositoryEvents({
      config,
      state,
      signal: controller.signal,
      run,
      log: vi.fn(),
    });

    expect(run).toHaveBeenCalledWith(
      config,
      expect.objectContaining({ state, signal: controller.signal }),
    );
    controller.abort();
    await expect(hosted.completed).resolves.toBeUndefined();
  });

  it('fails materializer startup when the hosted consumer fails before readiness', async () => {
    const state = new RepositoryEventsState({
      load: async () => undefined,
      save: async () => undefined,
    });
    await expect(
      startHostedRepositoryEvents({
        config,
        state,
        signal: new AbortController().signal,
        run: async () => {
          throw new Error('identity unavailable');
        },
      }),
    ).rejects.toThrow('identity unavailable');
  });
});
