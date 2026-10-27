import { readWebXAttribution, loadXPixel } from '../packages/api-contract/src/x-attribution.js';

// Custom conversions in X Ads account 18ce55ws4zb, pixel rhefr.
const downloadEvents: Record<string, string> = {
  ios: 'tw-rhefr-ri2vz',
  android: 'tw-rhefr-ri2w3',
  macos: 'tw-rhefr-ri2w4',
  windows: 'tw-rhefr-ri2w5',
  linux: 'tw-rhefr-ri2w6',
};

const pixel = loadXPixel(readWebXAttribution());
if (pixel) {
  for (const tile of document.querySelectorAll<HTMLElement>('[data-platform]')) {
    const platform = tile.dataset.platform;
    const eventId =
      platform && Object.hasOwn(downloadEvents, platform) ? downloadEvents[platform] : undefined;
    if (!eventId) continue;
    tile.addEventListener('click', () => {
      // Tracking must never interrupt the download link's default navigation.
      try {
        pixel('event', eventId, { contents: [{ content_id: platform, content_name: platform }] });
      } catch {}
    });
  }
}
