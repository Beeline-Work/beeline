import { describe, it, expect, vi, afterEach } from 'vitest';
import { generateStarterBanter, validBanterLine, starterBanterBeforeDeadline } from './starter-banter.js';
const beebee = { id: 'b', name: 'Beebee', handle: 'beebee42', instructions: 'real beebee instructions' };
const luna = { id: 'l', name: 'Luna', handle: 'luna42', instructions: 'real luna instructions' };
const good = ['@luna42, Alex arrived. I hope my coffee can keep up.', '@beebee42, I hope Alex brings a YouTube video to polish.', 'Alex is reading now. I should look busy.'];
afterEach(() => vi.useRealTimers());
describe('starter banter', () => {
  it('uses each real instruction and carries the accepted conversation forward', async () => {
    const complete = vi.fn().mockResolvedValueOnce(good[0]).mockResolvedValueOnce(good[1]).mockResolvedValueOnce(good[2]);
    const lines = await generateStarterBanter({ name: 'Alex', time: 'Monday 9 AM', beebee, luna, complete, signal: new AbortController().signal, brief: '{name} {time} @luna @beebee' });
    expect(lines?.map(line => line.text)).toEqual(good);
    expect(complete.mock.calls.map(call => call[0].id)).toEqual(['b', 'l', 'b']);
    expect(complete.mock.calls[1]![1][0].content).toBe(luna.instructions);
    expect(complete.mock.calls[1]![1][1].content).toContain(good[0]);
    expect(complete.mock.calls[2]![1][1].content).toContain(good[1]);
  });
  it.each(['@luna42 Alex is fresh kill', '', 'Alex, he is here @luna42', 'Alex told her @luna42', 'Alex and Beebee @luna42', 'Alex @luna', '@luna42 Alexis arrived', `Alex @luna42 ${'word '.repeat(23)}`])('rejects invalid line %s', text => {
    expect(validBanterLine(text, 'Alex', beebee, luna)).toBe(false);
  });
  it('rejects an invalid first line without a retry or partial banter', async () => {
    const complete = vi.fn().mockResolvedValue('');
    expect(await generateStarterBanter({ name: 'Alex', time: 'Monday', beebee, luna, complete, signal: new AbortController().signal, brief: '' })).toBeNull();
    expect(complete).toHaveBeenCalledTimes(1);
  });
  it('rejects an invalid later line without returning partial banter', async () => {
    const complete = vi.fn().mockResolvedValueOnce(good[0]).mockResolvedValueOnce('');
    expect(await generateStarterBanter({ name: 'Alex', time: 'Monday', beebee, luna, complete, signal: new AbortController().signal, brief: '' })).toBeNull();
    expect(complete).toHaveBeenCalledTimes(2);
  });
  it('rejects a late result on completion without an idle abort', async () => {
    vi.useFakeTimers();
    const control = new AbortController();
    let finish!: (value: []) => void;
    const result = starterBanterBeforeDeadline(new Promise<[]>((resolve) => { finish = resolve; }), Date.now(), control);
    await vi.advanceTimersByTimeAsync(19_999);
    expect(control.signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(control.signal.aborted).toBe(false);
    finish([]);
    expect(await result).toBeNull();
    expect(control.signal.aborted).toBe(true);
  });
  it('rejects a result after the opening deadline has elapsed', async () => {
    const control = new AbortController();
    expect(await starterBanterBeforeDeadline(Promise.resolve([]), Date.now() - 20_001, control)).toBeNull();
    expect(control.signal.aborted).toBe(true);
  });
  it('does not wait when generation has already failed', async () => {
    expect(await starterBanterBeforeDeadline(Promise.reject(new Error('upstream')), Date.now(), new AbortController())).toBeNull();
  });
});
