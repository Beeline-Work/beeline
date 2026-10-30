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

/**
 * Let the host paint a React update before more JavaScript runs.
 * Frame callbacks resume as microtasks, which still run before that paint,
 * so the work continues on a timer after the frame callbacks return.
 * Tests with no frame pump yield a macrotask instead of hanging.
 */
export function yieldToNextPaint(): Promise<void> {
  return new Promise((resolve) => {
    const resume = () => setTimeout(resolve, 0);
    if (scheduleAnimationFrame(() => {
      if (scheduleAnimationFrame(resume) === false) resume();
    })) return;
    setTimeout(resolve, 0);
  });
}
