import { X509Certificate } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

type AssetLinks = Array<{
  relation: string[];
  target: {
    namespace: string;
    package_name: string;
    sha256_cert_fingerprints: string[];
  };
}>;

describe('Android verified invite links', () => {
  it('binds both assetlinks copies to the release signing certificate', () => {
    const mobileRoot = fileURLToPath(new URL('../..', import.meta.url));
    const relayAssetLinks = JSON.parse(
      readFileSync(
        new URL('../../../../relay-stack/web/.well-known/assetlinks.json', import.meta.url),
        'utf8',
      ),
    ) as AssetLinks;
    const mobileAssetLinks = JSON.parse(
      readFileSync(new URL('../../public/.well-known/assetlinks.json', import.meta.url), 'utf8'),
    ) as AssetLinks;
    const certificatePem = execFileSync(
      'keytool',
      [
        '-exportcert',
        '-rfc',
        '-keystore',
        `${mobileRoot}/android-signing/release.keystore`,
        '-storepass',
        'buzzyrel123',
        '-alias',
        'buzz-release',
      ],
      { encoding: 'utf8' },
    );
    const releaseFingerprint = new X509Certificate(certificatePem).fingerprint256;

    expect(mobileAssetLinks).toEqual(relayAssetLinks);
    expect(relayAssetLinks).toEqual([
      {
        relation: ['delegate_permission/common.handle_all_urls'],
        target: {
          namespace: 'android_app',
          package_name: 'app.buzzy.mobile',
          sha256_cert_fingerprints: [releaseFingerprint],
        },
      },
    ]);
  });
});
