import { cancelScheduledAnimationFrame, scheduleAnimationFrame } from './host-scheduler';

export function requireByteWork(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  const error = new Error('The file is no longer visible.'); error.name = 'AbortError'; throw error;
}

function nextFrame(signal?: AbortSignal): Promise<void> {
  requireByteWork(signal);
  return new Promise((resolve, reject) => {
    let active = true; let handle: number | false = false;
    const stop = () => {
      if (!active) return;
      active = false;
      if (handle !== false) cancelScheduledAnimationFrame(handle);
      signal?.removeEventListener('abort', stop);
      try { requireByteWork(signal); } catch (error) { reject(error); }
    };
    handle = scheduleAnimationFrame(() => {
      if (!active) return;
      active = false; signal?.removeEventListener('abort', stop); resolve();
    });
    if (handle === false) { active = false; reject(new Error('Native file work requires a frame scheduler.')); return; }
    signal?.addEventListener('abort', stop, { once: true });
    if (signal?.aborted) stop();
  });
}

/** Finite work for one admitted object. Yielding never observes a remote
 * source or schedules another attempt. An abort releases a suspended frame. */
export async function runByteChunks(size: number, chunkBytes: number,
  work: (offset: number, length: number) => void, signal?: AbortSignal): Promise<void> {
  let offset = 0; let frameBytes = 0; let frameStart = performance.now();
  while (offset < size) {
    requireByteWork(signal);
    const length = Math.min(chunkBytes, size - offset);
    work(offset, length); offset += length; frameBytes += length;
    if (offset < size && (frameBytes >= 1024 * 1024 || performance.now() - frameStart >= 4)) {
      // Nonvisual hosts retain the local compatibility implementation. Real
      // native hosts have rAF even while backgrounded; abort ends that wait.
      if (typeof globalThis.requestAnimationFrame === 'function') await nextFrame(signal);
      frameBytes = 0; frameStart = performance.now();
    }
  }
  requireByteWork(signal);
}
