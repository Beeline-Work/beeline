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
