import { beforeEach, describe, expect, it, vi } from 'vitest';

const shell = vi.hoisted(() => ({ desktop: false }));
const linking = vi.hoisted(() => ({ openURL: vi.fn(async () => undefined) }));
const opener = vi.hoisted(() => ({ openUrl: vi.fn(async () => undefined) }));

vi.mock('@/utils/isDesktopShell', () => ({ isDesktopShell: () => shell.desktop }));
vi.mock('react-native', () => ({ Linking: linking }));
vi.mock('@tauri-apps/plugin-opener', () => opener);

import { openExternalUrl } from './open-external-url';

describe('openExternalUrl', () => {
  beforeEach(() => {
    shell.desktop = false;
    vi.clearAllMocks();
  });

  it('uses the native system opener in the desktop shell', async () => {
    shell.desktop = true;
    await openExternalUrl('https://github.com/settings/installations/7');
    expect(opener.openUrl).toHaveBeenCalledWith('https://github.com/settings/installations/7');
    expect(linking.openURL).not.toHaveBeenCalled();
  });

  it('uses Expo Linking outside the desktop shell', async () => {
    await openExternalUrl('https://github.com/settings/installations/7');
    expect(linking.openURL).toHaveBeenCalledWith('https://github.com/settings/installations/7');
    expect(opener.openUrl).not.toHaveBeenCalled();
  });
});
