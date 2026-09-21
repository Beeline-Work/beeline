import { existsSync, readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

/**
 * A `<Stack.Screen name="x">` whose route file is gone is not an error expo
 * router raises loudly — it warns `[Layout children]: No route named "x"` and
 * drops the screen, so the path it names has no route at all. Every declared
 * screen must therefore be backed by a file.
 */
const layout = readFileSync(new URL('./_layout.tsx', import.meta.url), 'utf8');

const declaredScreens = [...layout.matchAll(/name="([^"]+)"/g)].map((match) => match[1]);

function routeFileExists(route: string): boolean {
  return ['.tsx', '.ts'].some((extension) =>
    existsSync(new URL(`./${route}${extension}`, import.meta.url)),
  );
}

describe('declared app routes', () => {
  it('declares at least the routes this app is built around', () => {
    expect(declaredScreens).toContain('index');
    expect(declaredScreens).toContain('settings/index');
    expect(declaredScreens).toContain('beeline/settings/index');
  });

  it.each(
    // Dynamic segments carry brackets the URL form rewrites; every other
    // declared screen maps straight onto a file path.
    [...new Set(declaredScreens)].map((route) => [route] as const),
  )('backs the declared screen %s with a route file', (route) => {
    expect(routeFileExists(route)).toBe(true);
  });

  it('sends the bare settings path to the one account hub', () => {
    const settingsIndex = readFileSync(new URL('./settings/index.tsx', import.meta.url), 'utf8');

    expect(settingsIndex).toContain('<Redirect href="/beeline/settings" />');
  });
});
