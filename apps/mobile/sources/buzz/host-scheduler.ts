/**
 * Host timers and frame pumps must keep their Window/Worker receiver.
 * Storing `clearTimeout` / `requestAnimationFrame` on another object and
 * calling it as a method raises `TypeError: Illegal invocation` on web
 * (Chrome included for timers; WebKit/Firefox also for rAF).
 */

export function scheduleAnimationFrame(callback: FrameRequestCallback): number | false {
  if (typeof globalThis.requestAnimationFrame !== 'function') return false;
  return globalThis.requestAnimationFrame(callback);
}

export function cancelScheduledAnimationFrame(handle: number): void {
  if (typeof globalThis.cancelAnimationFrame !== 'function') return;
  globalThis.cancelAnimationFrame(handle);
}

/** Resume after a host frame has had an opportunity to paint the update. */
export function yieldToNextPaint(): Promise<void> {
  return new Promise(resolve => {
    const resume = () => resolve();
    if (scheduleAnimationFrame(() => {
      if (scheduleAnimationFrame(resume) === false) resume();
    }) === false) resume();
  });
}
