import { describe, expect, it } from 'vitest';
import { FreeAgentIdle } from './free-agent-idle.js';

/** A wall clock and a monotonic clock that advance together unless suspended. */
function clocks() {
  let wall = 1_000_000;
  let monotonic = 0;
  return {
    now: () => wall,
    monotonic: () => monotonic,
    advance(ms: number) {
      wall += ms;
      monotonic += ms;
    },
    /** A Fly suspension: wall time passes, this process's monotonic time does not. */
    suspend(ms: number) {
      wall += ms;
    },
  };
}

function harness(options: { accept?: boolean } = {}) {
  const clock = clocks();
  let turns = 0;
  const requests: number[] = [];
  const resumes: number[] = [];
  const idle = new FreeAgentIdle({
    idleMs: 60_000,
    activeTurns: () => turns,
    requestSleep: async () => {
      requests.push(clock.now());
      return options.accept ?? true;
    },
    onResume: () => resumes.push(clock.now()),
    now: clock.now,
    monotonic: clock.monotonic,
  });
  /** Tick once per second for `seconds`. */
  const run = async (seconds: number) => {
    for (let index = 0; index < seconds; index++) {
      clock.advance(1_000);
      await idle.tick();
    }
  };
  return {
    clock,
    idle,
    requests,
    resumes,
    run,
    setTurns: (value: number) => {
      turns = value;
    },
  };
}

describe('free agent idle sleep', () => {
  it('asks to sleep 60 s after the last turn ends, and not before', async () => {
    const h = harness();
    h.setTurns(1);
    await h.run(30); // a 30-second turn
    h.setTurns(0);
    const turnEnded = h.clock.now();
    await h.run(59);
    expect(h.requests).toEqual([]);
    await h.run(1);
    expect(h.requests).toEqual([turnEnded + 60_000]);
  });

  it('restarts the window on any activity', async () => {
    const h = harness();
    await h.run(45);
    h.idle.noteActivity();
    const active = h.clock.now();
    await h.run(59);
    expect(h.requests).toEqual([]);
    await h.run(1);
    expect(h.requests).toEqual([active + 60_000]);
  });

  it('waits a whole window again after the server refuses because a wake is pending', async () => {
    const h = harness({ accept: false });
    await h.run(60);
    expect(h.requests).toHaveLength(1);
    await h.run(59);
    expect(h.requests).toHaveLength(1);
    await h.run(1);
    expect(h.requests).toHaveLength(2);
  });

  it('reconnects at once when the Machine resumes, and does not ask to sleep right away', async () => {
    const h = harness();
    await h.run(60);
    expect(h.requests).toHaveLength(1);
    // Fly suspends the Machine for ten minutes, then a wake resumes it.
    h.clock.suspend(600_000);
    await h.run(1);
    expect(h.resumes).toHaveLength(1);
    await h.run(59);
    expect(h.requests).toHaveLength(1);
    await h.run(1);
    expect(h.requests).toHaveLength(2);
  });

  it('never treats a busy Machine as idle', async () => {
    const h = harness();
    h.setTurns(2);
    await h.run(600);
    expect(h.requests).toEqual([]);
    expect(h.resumes).toEqual([]);
  });
});
