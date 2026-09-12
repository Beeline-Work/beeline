const RELEASE_ROOT = 'https://github.com/Beeline-Work/beeline/releases/latest/download';

export const DESKTOP_INSTALLERS = Object.freeze([
  { platform: 'macos', label: 'macOS · Universal DMG', asset: 'Beeline-universal.dmg' },
  {
    platform: 'windows',
    label: 'Windows · Installer (EXE)',
    asset: 'Beeline-x86_64-setup.exe',
    primary: true,
  },
  { platform: 'windows', label: 'Windows · Installer (MSI)', asset: 'Beeline-x86_64.msi' },
  { platform: 'linux', label: 'Linux · AppImage', asset: 'Beeline-x86_64.AppImage', primary: true },
  { platform: 'linux', label: 'Linux · Debian package', asset: 'Beeline-x86_64.deb' },
  { platform: 'linux', label: 'Linux · RPM package', asset: 'Beeline-x86_64.rpm' },
].map((installer) =>
  Object.freeze({ ...installer, url: `${RELEASE_ROOT}/${installer.asset}` }),
));

const PRIMARY_INSTALLERS = Object.freeze({
  macos: DESKTOP_INSTALLERS.find((installer) => installer.platform === 'macos'),
  windows: DESKTOP_INSTALLERS.find((installer) => installer.platform === 'windows' && installer.primary),
  linux: DESKTOP_INSTALLERS.find((installer) => installer.platform === 'linux' && installer.primary),
});

function isX64({ userAgent = '', uaDataArchitecture = '', uaDataBitness = '' }) {
  const architecture = uaDataArchitecture.toLowerCase();
  return (
    /(?:x86_64|x64|amd64|win64|wow64)/i.test(userAgent) ||
    ((architecture === 'x86' || architecture === 'x86_64' || architecture === 'amd64') &&
      uaDataBitness === '64')
  );
}

export function selectPlatform(input = {}) {
  const userAgent = input.userAgent ?? '';
  const platform = `${input.uaDataPlatform ?? ''} ${input.platform ?? ''}`.toLowerCase();

  if (/iphone|ipad|ipod/i.test(userAgent) || (/mac/i.test(platform) && Number(input.maxTouchPoints ?? 0) > 1)) {
    return 'ios';
  }
  if (/android/i.test(userAgent) || /android/i.test(platform)) return 'android';
  if (/mac/i.test(platform) || /macintosh|mac os x/i.test(userAgent)) {
    return 'macos';
  }
  if (/win/i.test(platform) || /windows/i.test(userAgent)) {
    return 'windows';
  }
  if (/linux/i.test(platform) || /linux/i.test(userAgent)) {
    return 'linux';
  }
  return undefined;
}

export function selectDesktopInstaller(input = {}) {
  const platform = selectPlatform(input);
  if (!platform || platform === 'ios' || platform === 'android') return undefined;
  if ((platform === 'windows' || platform === 'linux') && !isX64(input)) return undefined;
  return PRIMARY_INSTALLERS[platform];
}

export async function browserPlatformInput(navigatorLike = globalThis.navigator) {
  const input = {
    userAgent: navigatorLike?.userAgent ?? '',
    platform: navigatorLike?.platform ?? '',
    maxTouchPoints: navigatorLike?.maxTouchPoints ?? 0,
    uaDataPlatform: navigatorLike?.userAgentData?.platform ?? '',
    uaDataMobile: navigatorLike?.userAgentData?.mobile,
  };
  if (typeof navigatorLike?.userAgentData?.getHighEntropyValues === 'function') {
    try {
      const detail = await navigatorLike.userAgentData.getHighEntropyValues(['architecture', 'bitness']);
      input.uaDataArchitecture = detail.architecture ?? '';
      input.uaDataBitness = detail.bitness ?? '';
    } catch {
      // Reduced user-agent clients safely keep the chooser instead of guessing.
    }
  }
  return input;
}

export async function initializePlatformDownloads(
  documentLike = globalThis.document,
  navigatorLike = globalThis.navigator,
) {
  const tiles = [...(documentLike?.querySelectorAll?.('[data-platform]') ?? [])];
  if (tiles.length === 0) return;

  const platform = selectPlatform({
    userAgent: navigatorLike?.userAgent ?? '',
    platform: navigatorLike?.platform ?? '',
    maxTouchPoints: navigatorLike?.maxTouchPoints ?? 0,
    uaDataPlatform: navigatorLike?.userAgentData?.platform ?? '',
  });
  for (const tile of tiles) {
    tile.classList.remove('is-current');
    tile.removeAttribute('aria-current');
  }
  const current = tiles.find((tile) => tile.dataset.platform === platform);
  current?.classList.add('is-current');
  current?.setAttribute('aria-current', 'true');
}

if (typeof document !== 'undefined') initializePlatformDownloads();
