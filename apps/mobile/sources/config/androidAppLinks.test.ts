import { X509Certificate } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
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

// The release keystore lives only in the ANDROID_SIDELOAD_* repository
// secrets (apps/mobile/android-signing/README.md), never in the tree, so this
// fingerprint check only runs when a developer has materialized the keystore
// and exported its store password locally.
const keystorePath = fileURLToPath(
  new URL('../../android-signing/release.keystore', import.meta.url),
);
const storePassword = process.env.ANDROID_SIDELOAD_STORE_PASSWORD;
const canCheckFingerprint = existsSync(keystorePath) && Boolean(storePassword);

describe('Android verified invite links', () => {
  it.skipIf(!canCheckFingerprint)(
    'binds both assetlinks copies to the release signing certificate',
    () => {
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
          keystorePath,
          '-storepass',
          storePassword as string,
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
            package_name: 'app.usebeeline',
            sha256_cert_fingerprints: [releaseFingerprint],
          },
        },
      ]);
    },
  );
});
