/**
 * Expo's single-page web export gives #root height: 100%. On Android Chrome
 * that resolves against the viewport with the URL bar hidden, even while the
 * bar is visible. The composer then mounts below the visible screen.
 * Keep the app (and its own transcript scrollers) inside the visible viewport.
 * +html.tsx only runs for static rendering, not our web.output: 'single'.
 */
export function installWebViewport(): (() => void) | undefined {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  const root = document.getElementById('root');
  if (!root) return;
  const viewport = window.visualViewport;
  const previousHeight = root.style.height;
  const resize = () => {
    // Pinch zoom changes the visible rectangle, not the app's layout. Retain
    // the unzoomed height so magnification doesn't reflow the conversation.
    if (viewport && Math.abs(viewport.scale - 1) > 0.01) return;
    const height = viewport?.height ?? window.innerHeight;
    if (height > 0 && Number.isFinite(height)) root.style.height = `${height}px`;
  };
  resize();
  viewport?.addEventListener('resize', resize);
  window.addEventListener('resize', resize);
  window.addEventListener('pageshow', resize);
  return () => {
    viewport?.removeEventListener('resize', resize);
    window.removeEventListener('resize', resize);
    window.removeEventListener('pageshow', resize);
    root.style.height = previousHeight;
  };
}

installWebViewport();
