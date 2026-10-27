import { readWebXAttribution, loadXPixel } from '../packages/api-contract/src/x-attribution.js';

// Custom conversions in X Ads account 18ce55ws4zb, pixel rhefr.
const downloadEvents: Record<string, string> = {
  ios: 'tw-rhefr-ri2vz',
  android: 'tw-rhefr-ri2w3',
  macos: 'tw-rhefr-ri2w4',
  windows: 'tw-rhefr-ri2w5',
  linux: 'tw-rhefr-ri2w6',
};

const attribution = readWebXAttribution();
const pixel = loadXPixel(attribution);
{
  for (const tile of document.querySelectorAll<HTMLElement>('[data-platform]')) {
    const platform = tile.dataset.platform;
    const eventId =
      platform && Object.hasOwn(downloadEvents, platform) ? downloadEvents[platform] : undefined;
    if (!eventId) continue;
    tile.addEventListener('click', () => {
      try {
        void fetch('https://server.usebeeline.app/v1/site/download-tap', {
          method: 'POST',
          credentials: 'omit',
          referrerPolicy: 'no-referrer',
          keepalive: true,
          headers: { 'content-type': 'text/plain' },
          body: JSON.stringify({ platform, source: attribution ? 'x' : 'organic' }),
        }).catch(() => {});
      } catch {}
      // Tracking must never interrupt the download link's default navigation.
      try {
        pixel?.('event', eventId, { contents: [{ content_id: platform, content_name: platform }] });
      } catch {}
    });
  }
}
