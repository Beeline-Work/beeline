export function accountSignInAvailable(platform: string, desktopShell: boolean): boolean {
  // Ordinary web is now a first-class desktop surface. Its monolith session
  // is origin-scoped (localStorage), while Tauri and native retain their
  // hardened credential stores.
  return platform === 'web' || desktopShell || platform === 'android' || platform === 'ios';
}
