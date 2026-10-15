import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

type AssetLinks = Array<{
  relation: string[];
  target: {
    namespace: string;
    package_name: string;
    sha256_cert_fingerprints: string[];
  };
}>;

const releaseFingerprint =
  'CB:CB:5F:6A:D8:87:2E:1D:B9:5F:9E:79:EA:7B:5F:F8:4F:66:71:AF:8C:E7:47:3F:64:8A:B9:D6:87:CB:97:FA';
const exposedFingerprint =
  'F1:0A:CD:08:4A:67:32:53:9D:3C:72:27:9C:8D:64:97:EB:3F:3A:3D:C4:EB:FF:74:F9:6C:57:76:D9:99:72:18';
const storeFingerprints = [
  '2E:15:6F:6A:ED:2E:17:40:46:A3:5A:B9:09:68:DA:07:5A:FC:4A:CA:52:53:4D:CE:10:3C:39:AA:4C:D7:48:BE',
  'DF:57:9B:3F:67:D7:5C:AE:45:2C:7A:D4:7D:D4:6C:EE:DE:24:ED:8B:4B:37:4D:46:1E:25:EB:34:26:B5:BE:A7',
];

describe('Android verified invite links', () => {
  it('trusts the rotated sideload certificate for both packages and preserves store certificates', () => {
    const relayAssetLinks = JSON.parse(
      readFileSync(
        new URL('../../../../relay-stack/web/.well-known/assetlinks.json', import.meta.url),
        'utf8',
      ),
    ) as AssetLinks;
    const mobileAssetLinks = JSON.parse(
      readFileSync(new URL('../../public/.well-known/assetlinks.json', import.meta.url), 'utf8'),
    ) as AssetLinks;

    expect(relayAssetLinks).toEqual([
      {
        relation: ['delegate_permission/common.handle_all_urls'],
        target: {
          namespace: 'android_app',
          package_name: 'app.usebeeline',
          sha256_cert_fingerprints: [releaseFingerprint, ...storeFingerprints],
        },
      },
      {
        relation: ['delegate_permission/common.handle_all_urls'],
        target: {
          namespace: 'android_app',
          package_name: 'app.usebeeline.mobile',
          sha256_cert_fingerprints: [releaseFingerprint],
        },
      },
    ]);
    expect(mobileAssetLinks).toEqual([relayAssetLinks[0]]);
    for (const entry of [...relayAssetLinks, ...mobileAssetLinks]) {
      expect(entry.target.sha256_cert_fingerprints).not.toContain(exposedFingerprint);
    }
  });
});
