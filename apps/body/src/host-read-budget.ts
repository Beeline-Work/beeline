import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, readdir, stat, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** A single machine's agents share six read slots and a cold-start rate limit. */
const READ_SLOTS = 6;
const BACKGROUND_SLOTS = 4;
const MAX_WAITERS = 256;
const ADMISSION_SPACING_MS = 50;
const STALE_SLOT_MS = 45_000;

export type ReadPriority = 'urgent' | 'background';

export class ReadBudgetFullError extends Error {
  constructor() {
    super('host daemon read budget is full');
  }
}

function wait(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}

function ownerAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Filesystem admission works across helper processes without a resident broker. */
export class HostReadBudget {
  private readonly directory: string;
  private waiting = 0;
  private active = 0;
  private totalWaitMs = 0;

  constructor(baseUrl: string, root = tmpdir()) {
    const uid = process.getuid?.() ?? 'unknown';
    const origin = new URL(baseUrl).origin;
    const key = createHash('sha256').update(origin).digest('hex').slice(0, 16);
    this.directory = join(root, `beeline-read-budget-${uid}-${key}`);
  }

  metrics(): { waiting: number; active: number; totalWaitMs: number } {
    return { waiting: this.waiting, active: this.active, totalWaitMs: this.totalWaitMs };
  }

  async acquire(priority: ReadPriority, deadlineAt: number): Promise<() => Promise<void>> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const ticket = `wait-${priority === 'urgent' ? '0' : '1'}-${String(Date.now()).padStart(13, '0')}-${randomUUID()}`;
    const ticketPath = join(this.directory, ticket);
    const tickets = (await readdir(this.directory)).filter((name) => name.startsWith('wait-'));
    if (tickets.length >= MAX_WAITERS) throw new ReadBudgetFullError();
    await writeFile(ticketPath, String(process.pid), { flag: 'wx', mode: 0o600 });
    const startedAt = Date.now();
    this.waiting += 1;
    try {
      while (Date.now() < deadlineAt) {
        const queue = (await readdir(this.directory)).filter((name) => name.startsWith('wait-')).sort();
        // A crashed helper must not keep a head-of-line ticket forever.
        for (const name of queue.slice(0, READ_SLOTS)) {
          if (name !== ticket) await this.reapStaleTicket(join(this.directory, name));
        }
        const liveQueue = (await readdir(this.directory)).filter((name) => name.startsWith('wait-')).sort();
        const rank = liveQueue.indexOf(ticket);
        const available = priority === 'urgent' ? READ_SLOTS : BACKGROUND_SLOTS;
        if (rank >= 0 && rank < available) {
          for (let slot = 0; slot < available; slot += 1) {
            const slotPath = join(this.directory, `slot-${slot}`);
            try {
              const handle = await open(slotPath, 'wx', 0o600);
              try {
                await handle.writeFile(JSON.stringify({ pid: process.pid, at: Date.now() }));
              } finally {
                await handle.close();
              }
              // Rate-limit only startup/background reads; claims and receipts
              // retain their reserved capacity and do not wait for a token.
              if (priority === 'background') {
                const admitted = await this.takeRateToken(deadlineAt);
                if (!admitted) {
                  await unlink(slotPath);
                  break;
                }
              }
              await unlink(ticketPath);
              this.waiting -= 1;
              this.active += 1;
              this.totalWaitMs += Date.now() - startedAt;
              return async () => {
                this.active -= 1;
                await unlink(slotPath).catch((error: NodeJS.ErrnoException) => {
                  if (error.code !== 'ENOENT') throw error;
                });
              };
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
              await this.reapStaleSlot(slotPath);
            }
          }
        }
        await wait(Math.min(40 + Math.floor(Math.random() * 30), Math.max(1, deadlineAt - Date.now())));
      }
      throw new ReadBudgetFullError();
    } finally {
      // A fulfilled acquisition already removed the ticket and decremented waiting.
      if (this.waiting > 0) {
        const stillQueued = await stat(ticketPath).then(() => true, () => false);
        if (stillQueued) {
          this.waiting -= 1;
          await unlink(ticketPath).catch(() => undefined);
        }
      }
    }
  }

  private async reapStaleSlot(path: string): Promise<void> {
    const details = await stat(path).catch(() => undefined);
    if (!details || Date.now() - details.mtimeMs < 2_000) return;
    const owner = await readFile(path, 'utf8').then((value) => {
      try { return JSON.parse(value) as { pid: number; at: number }; } catch { return undefined; }
    }, () => undefined);
    if (owner && ownerAlive(owner.pid) && Date.now() - owner.at < STALE_SLOT_MS) return;
    await unlink(path).catch(() => undefined);
  }

  private async reapStaleTicket(path: string): Promise<void> {
    const details = await stat(path).catch(() => undefined);
    if (!details || Date.now() - details.mtimeMs < 2_000) return;
    const pid = Number(await readFile(path, 'utf8').catch(() => '0'));
    if (pid > 0 && ownerAlive(pid) && Date.now() - details.mtimeMs < STALE_SLOT_MS) return;
    await unlink(path).catch(() => undefined);
  }

  private async takeRateToken(deadlineAt: number): Promise<boolean> {
    const lock = join(this.directory, 'rate.lock');
    let handle;
    try {
      handle = await open(lock, 'wx', 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      await this.reapStaleSlot(lock);
      return false;
    }
    try {
      const path = join(this.directory, 'next-admission');
      const next = Number(await readFile(path, 'utf8').catch(() => '0')) || 0;
      const now = Date.now();
      if (next > now || now >= deadlineAt) return false;
      await writeFile(path, String(now + ADMISSION_SPACING_MS), { mode: 0o600 });
      return true;
    } finally {
      await handle.close();
      await unlink(lock).catch(() => undefined);
    }
  }
}
