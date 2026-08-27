import type { EventsServiceConfig, runRepositoryEventsService } from '@beeline/body/events-service';
import type { RepositoryEventsState } from '@beeline/body/events-state';

type RepositoryEventsRunner = typeof runRepositoryEventsService;

export interface HostedRepositoryEventsOptions {
  config: EventsServiceConfig;
  state: RepositoryEventsState;
  signal: AbortSignal;
  run: RepositoryEventsRunner;
  log?: (line: string) => void;
}

/**
 * Start the repository-events consumer inside the materializer lifecycle.
 * Compose is the single-writer owner. Readiness is explicit: callers never
 * advertise a healthy materializer before local repository discovery and
 * identity loading finish.
 */
export async function startHostedRepositoryEvents(
  options: HostedRepositoryEventsOptions,
): Promise<{ completed: Promise<void> }> {
  let markReady!: (value: void) => void;
  const ready = new Promise<void>((resolve) => {
    markReady = resolve;
  });
  const run = options.run(options.config, {
    signal: options.signal,
    state: options.state,
    notifier: {
      ready: async (status) => {
        (options.log ?? console.log)(`[events] ${status}`);
        markReady();
      },
      progress: async (status) => {
        (options.log ?? console.log)(`[events] ${status}`);
      },
      stopping: async (status) => {
        (options.log ?? console.log)(`[events] ${status}`);
      },
    },
  });
  await Promise.race([
    ready,
    run.then(() => {
      throw new Error('repository-events consumer stopped before readiness');
    }),
  ]);
  return { completed: run };
}
