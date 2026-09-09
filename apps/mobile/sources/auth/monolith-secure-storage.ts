import { isDesktopShell } from '@/utils/isDesktopShell';

export interface MonolithSecureStorage {
  getItemAsync(key: string): Promise<string | null>;
  setItemAsync(key: string, value: string): Promise<void>;
  deleteItemAsync(key: string): Promise<void>;
}

async function desktopInvoke<T>(
  command: 'desktop_secure_get' | 'desktop_secure_set' | 'desktop_secure_remove',
  args: { key: string; value?: string },
): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<T>(command, args);
}

type DesktopInvoke = typeof desktopInvoke;

function desktopSecureStorage(invoke: DesktopInvoke): MonolithSecureStorage {
  return {
    getItemAsync: (key) => invoke<string | null>('desktop_secure_get', { key }),
    setItemAsync: (key, value) => invoke<void>('desktop_secure_set', { key, value }),
    deleteItemAsync: (key) => invoke<void>('desktop_secure_remove', { key }),
  };
}

export async function monolithSecureStorage(
  desktop = isDesktopShell(),
  invoke: DesktopInvoke = desktopInvoke,
): Promise<MonolithSecureStorage> {
  if (desktop) return desktopSecureStorage(invoke);
  return import('expo-secure-store');
}
