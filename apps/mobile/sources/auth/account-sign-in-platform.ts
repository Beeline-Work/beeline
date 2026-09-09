export function accountSignInAvailable(platform: string, desktopShell: boolean): boolean {
  return platform !== 'web' || desktopShell;
}
