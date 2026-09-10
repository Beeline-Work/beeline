export function accountSignInAvailable(platform: string, desktopShell: boolean): boolean {
  // Ordinary web is now a first-class desktop surface. Its monolith session
  // is tab-scoped (sessionStorage), while Tauri and native retain their
  // hardened credential stores.
  return platform === 'web' || desktopShell || platform === 'android' || platform === 'ios';
}
