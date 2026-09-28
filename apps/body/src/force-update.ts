import { journalInterruptedTurns, type InterruptedTurn } from './force-update-journal.js';
import { versionAtLeast } from './managed-update.js';

/** One forced handoff per daemon process, regardless of how many routes are refused. */
export class ForceUpdateCoordinator {
  private started = false;
  private work?: Promise<void>;

  constructor(private readonly options: {
    loadedVersion?: string;
    runtimeDir: string;
    interrupt: () => InterruptedTurn[];
    install: (minimum: string) => Promise<string>;
    restart: (desiredRelease: string) => Promise<void>;
    failed: (error: unknown) => void;
  }) {}

  get active(): boolean { return this.started; }
  get pending(): Promise<void> | undefined { return this.work; }

  request(minimum: string): void {
    if (this.started ||
        (this.options.loadedVersion && versionAtLeast(this.options.loadedVersion, minimum)))
      return;
    this.started = true;
    try {
      // No await between cancellation and the local journal. The successor
      // owns the receipt because the old release's HTTP writes now get 426.
      journalInterruptedTurns(this.options.runtimeDir, this.options.interrupt());
    } catch (error) {
      this.work = Promise.resolve().then(() => this.options.failed(error));
      return;
    }
    this.work = this.options.install(minimum)
      .then((desiredRelease) => this.options.restart(desiredRelease))
      .catch((error) => this.options.failed(error));
  }
}
