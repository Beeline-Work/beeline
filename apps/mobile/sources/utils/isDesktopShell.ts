export function isDesktopShell(): boolean {
  return (
    typeof window !== 'undefined' &&
    (window as typeof window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ !== undefined
  );
}
