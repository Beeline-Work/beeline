import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const read = (relative: string) =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');

const route = read('./[secret].tsx');
const home = read('../index.tsx');
const layout = read('../_layout.tsx');

describe('the review link route', () => {
  it('signs in and lands in the app, with no control and no hint on refusal', () => {
    expect(route).toContain('signInWithReviewSecret(secret)');
    expect(route).toContain("router.replace('/beeline/channels')");
    // A refusal is the ordinary sign-in screen; the reviewer link is never named.
    expect(route).toContain("router.replace('/beeline/onboarding')");
    for (const control of ['TouchableOpacity', 'Pressable', 'Button', 'onPress'])
      expect([control, route.includes(control)]).toEqual([control, false]);
  });

  it('reads the secret from the route and from the launching URL', () => {
    expect(route).toContain('parseReviewSecret(routeSecret)');
    expect(route).toContain('parseReviewSecret(incomingUrl ?? undefined)');
  });

  it('is honored on a cold start before the identity check redirects', () => {
    const decision = home.slice(
      home.indexOf('if (initialReviewSecret)'),
      home.lastIndexOf('}, ['),
    );
    expect(decision).toContain("pathname: '/review/[secret]'");
    expect(decision.indexOf('initialReviewSecret')).toBeLessThan(
      decision.indexOf('hasBuzzIdentity'),
    );
    expect(layout).toContain('name="review/[secret]"');
  });

  it('is reachable only from the verified app link — nothing in the app links to it', () => {
    const referring = execFileSync(
      'git',
      ['grep', '-l', '--untracked', '-F', "'/review/[secret]'", '--', 'sources'],
      { cwd: fileURLToPath(new URL('../../../..', import.meta.url)), encoding: 'utf8' },
    )
      .split('\n')
      .filter(Boolean);
    // Only the cold-start hand-off names the route; nothing renders a way in.
    expect(referring.sort()).toEqual([
      'sources/app/(app)/index.tsx',
      'sources/app/(app)/review/review-route.test.ts',
    ]);
  });
});
