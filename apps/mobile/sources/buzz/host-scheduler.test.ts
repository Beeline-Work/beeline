import { afterEach, describe, expect, it, vi } from 'vitest';
import { cancelScheduledAnimationFrame, scheduleAnimationFrame } from './host-scheduler';

function installThrowingHostMethod(
  name: 'requestAnimationFrame' | 'cancelAnimationFrame',
  impl: (this: unknown, arg: unknown) => unknown,
): void {
  vi.stubGlobal(name, function hostMethod(this: unknown, arg: unknown) {
    if (this !== globalThis) throw new TypeError('Illegal invocation');
    return impl.call(this, arg);
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('host-scheduler', () => {
  it('calls requestAnimationFrame on globalThis so a throwing browser cannot raise Illegal invocation', () => {
    const receivers: unknown[] = [];
    const queued: FrameRequestCallback[] = [];
    installThrowingHostMethod('requestAnimationFrame', function (this: unknown, callback: unknown) {
      receivers.push(this);
      queued.push(callback as FrameRequestCallback);
      return 7;
    });

    const handle = scheduleAnimationFrame(() => undefined);
    expect(handle).toBe(7);
    expect(receivers).toEqual([globalThis]);
    expect(queued).toHaveLength(1);
  });

  it('returns false when the host has no frame pump', () => {
    vi.stubGlobal('requestAnimationFrame', undefined);
    expect(scheduleAnimationFrame(() => undefined)).toBe(false);
  });

  it('cancels on globalThis so a throwing cancelAnimationFrame cannot raise Illegal invocation', () => {
    const receivers: unknown[] = [];
    const cancelled: number[] = [];
    installThrowingHostMethod('cancelAnimationFrame', function (this: unknown, handle: unknown) {
      receivers.push(this);
      cancelled.push(handle as number);
    });

    cancelScheduledAnimationFrame(11);
    expect(receivers).toEqual([globalThis]);
    expect(cancelled).toEqual([11]);
  });
});
