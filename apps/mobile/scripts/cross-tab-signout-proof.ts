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
    const signedOut = new Promise((resolve) => window.addEventListener('storage', resolve, { once: true }));
    const frame = document.createElement('iframe');
    frame.src = `${location.href.split('?')[0]}?tab=other`;
    document.body.append(frame);
    await signedOut;
    await new Promise((resolve) => setTimeout(resolve, 0));
    const hot = mobileSurfaceCache.peek(address, guard)?.text ?? 'none';
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
