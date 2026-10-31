import { setTimeout as pause } from 'node:timers/promises';

/** Setup only: never read an old hierarchy or include dumps in measured intervals. */
export async function dumpUi(adb, step, { wait = pause } = {}) {
  const path = '/sdcard/latency-rig.xml';
  let failure;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      adb('shell', 'rm', '-f', path);
      const result = adb('shell', 'uiautomator', 'dump', path);
      if (!result.includes('dumped to:')) throw new Error(result.trim() || 'No hierarchy written');
      const xml = adb('shell', 'cat', path);
      if (!xml.includes('<hierarchy') || !xml.includes('</hierarchy>'))
        throw new Error('Incomplete Android hierarchy');
      return xml;
    } catch (error) {
      failure = error;
    }
    // A fixture send can leave a pending WORKING receipt with no real helper
    // to finish it. The app expires it at 90 seconds; its elapsed counter
    // legitimately prevents accessibility idle until then. Three ten-second
    // dump attempts plus these gaps cover that finite lifetime, then fail.
    if (attempt < 3) await wait(35_000);
  }
  throw new Error(`Android UI dump failed at ${step} after three attempts: ${failure?.message}`, { cause: failure });
}
