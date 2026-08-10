import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const repoFile = (path: string) =>
  readFileSync(new URL(`../../../${path}`, import.meta.url), 'utf8');

describe('relay invite web front', () => {
  it('publishes the production app associations', () => {
    const apple = JSON.parse(
      repoFile('relay-stack/web/.well-known/apple-app-site-association'),
    );
    const android = JSON.parse(
      repoFile('relay-stack/web/.well-known/assetlinks.json'),
    );

    expect(apple).toEqual({
      applinks: {
        apps: [],
        details: [
          {
            appID: '89KT3SWYAF.app.buzzy.mobile',
            paths: ['/join/*'],
          },
        ],
      },
    });
    expect(android).toEqual([
      {
        relation: ['delegate_permission/common.handle_all_urls'],
        target: {
          namespace: 'android_app',
          package_name: 'app.buzzy.mobile',
          sha256_cert_fingerprints: [
            'F1:0A:CD:08:4A:67:32:53:9D:3C:72:27:9C:8D:64:97:EB:3F:3A:3D:C4:EB:FF:74:F9:6C:57:76:D9:99:72:18',
          ],
        },
      },
    ]);
  });

  it('serves only valid invite paths and proxies the relay including upgrades', () => {
    const nginx = repoFile('relay-stack/nginx.conf');
    const compose = repoFile('relay-stack/compose.yml');
    const landing = repoFile('relay-stack/web/join/index.html');
    const script = repoFile('relay-stack/web/join/invite.js');

    expect(nginx).toContain('^/join/bzi_[0-9a-f]{64}/?$');
    expect(nginx).toContain('location = /join/invite.js');
    expect(nginx).toContain('proxy_pass http://relay:3000');
    expect(nginx).toContain('proxy_set_header Upgrade $http_upgrade');
    expect(compose).toContain('${BUZZ_HTTP_PORT:-3010}:3000');
    expect(compose).toContain('./web:/usr/share/nginx/html:ro');
    expect(landing).toContain("You're invited to a Beeline Workspace");
    expect(script).toContain('buzzy://join/');
  });
});
