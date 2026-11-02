/** Observe close at spawn so teardown can also await an already closed child. */
export function captureTeardown(child, { timeoutMs = 5000, warn = console.error } = {}) {
  let closed = false;
  const close = new Promise((resolve) => child.once('close', () => { closed = true; resolve(); }));
  // A spawn failure still emits close. Handle error without hiding the capture's error.
  child.on('error', (error) => warn(`Logcat capture failed: ${error.message}`));
  return async () => {
    if (closed) return;
    child.kill('SIGTERM');
    let timer;
    try {
      await Promise.race([close, new Promise((resolve) => {
        timer = setTimeout(() => {
          child.kill('SIGKILL');
          warn('Logcat capture did not close before teardown deadline');
          resolve();
        }, timeoutMs);
      })]);
    } finally { clearTimeout(timer); }
  };
}
