import { clearMobileSurfaceStorage, mobileSurfaceCache, surfaceAddress } from '@/buzz/surface-storage';

// Two tabs of one origin: this page, and the same page in a frame that signs out.
const address = surfaceAddress('https://server.example', 'a'.repeat(64), '/room/r1');
const guard = (value: unknown): value is { text: string } => typeof value === 'object' && value !== null;

if (new URLSearchParams(location.search).get('tab') === 'other') {
  clearMobileSurfaceStorage();
} else {
  void (async () => {
    localStorage.clear();
    await mobileSurfaceCache.write(address, { text: 'first account' }, guard);
    const before = mobileSurfaceCache.peek(address, guard)?.text ?? 'none';
    const frame = document.createElement('iframe');
    frame.src = `${location.href.split('?')[0]}?tab=other`;
    document.body.append(frame);
    // The other tab's clear lands in localStorage before the cross-window
    // storage event reaches this tab, and under load the page can end
    // before a one-shot event wait returns. Poll the hot copy instead: the
    // event handler is what drops it, so polling checks exactly what the
    // assertions need, with a bound instead of an unbounded wait.
    let hot = mobileSurfaceCache.peek(address, guard)?.text ?? 'none';
    for (let tick = 0; tick < 300 && hot !== 'none'; tick++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      hot = mobileSurfaceCache.peek(address, guard)?.text ?? 'none';
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
    const read = (await mobileSurfaceCache.read(address, guard))?.text ?? 'none';
    const shared = Object.keys(localStorage).filter((key) => key.startsWith('beeline.surface.')).length;
    document.getElementById('result')!.textContent = [
      hot === 'none' && read === 'none' && shared === 0 ? 'PASS' : 'FAIL',
      `this tab before the other tab signs out: ${before}`,
      `this tab's hot copy after: ${hot}`,
      `this tab's read after: ${read}`,
      `shared response keys after: ${shared}`,
    ].join('\n');
  })();
}
