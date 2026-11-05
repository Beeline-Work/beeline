/** All clients in the machine helper share six slots, four for background reads. */
const READ_SLOTS = 6;
const BACKGROUND_SLOTS = 4;
const MAX_WAITERS = 256;

export type ReadPriority = 'urgent' | 'background';

export class ReadBudgetFullError extends Error {
  constructor() {
    super('host daemon read budget is full');
  }
}

export class HostReadBudget {
  private readonly slots = Array<boolean>(READ_SLOTS).fill(false);
  private readonly queue: { priority: ReadPriority; admit: (slot: number) => void }[] = [];
  private active = 0;
  private totalWaitMs = 0;

  metrics(): { waiting: number; active: number; totalWaitMs: number } {
    return { waiting: this.queue.length, active: this.active, totalWaitMs: this.totalWaitMs };
  }

  acquire(priority: ReadPriority, deadlineAt: number, signal?: AbortSignal): Promise<() => Promise<void>> {
    if (signal?.aborted || Date.now() >= deadlineAt || this.queue.length >= MAX_WAITERS)
      return Promise.reject(new ReadBudgetFullError());
    const startedAt = Date.now();
    return new Promise((resolve, reject) => {
      const remove = () => {
        clearTimeout(deadline);
        signal?.removeEventListener('abort', cancel);
        this.queue.splice(this.queue.indexOf(waiter), 1);
      };
      const cancel = () => { remove(); reject(new ReadBudgetFullError()); };
      const deadline = setTimeout(cancel, deadlineAt - startedAt);
      const waiter = { priority, admit: (slot: number) => {
        if (Date.now() >= deadlineAt || signal?.aborted) { cancel(); return; }
        remove();
        this.slots[slot] = true;
        this.active += 1;
        this.totalWaitMs += Date.now() - startedAt;
        resolve(async () => {
          this.slots[slot] = false;
          this.active -= 1;
          this.drain();
        });
      } };
      this.queue.push(waiter);
      signal?.addEventListener('abort', cancel, { once: true });
      this.drain();
    });
  }

  private drain(): void {
    for (const waiter of [...this.queue].sort((a, b) => Number(b.priority === 'urgent') - Number(a.priority === 'urgent'))) {
      const limit = waiter.priority === 'urgent' ? READ_SLOTS : BACKGROUND_SLOTS;
      const slot = this.slots.findIndex((busy, index) => !busy && index < limit);
      if (slot >= 0) waiter.admit(slot);
    }
  }
}

export const hostReadBudget = new HostReadBudget();
