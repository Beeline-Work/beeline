import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import {
  FUNNEL_SCREENS,
  funnelScreenFromSegments,
} from '../../../../packages/api-contract/src/signin-funnel';

const app = fileURLToPath(new URL('../app', import.meta.url));
function routeFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return routeFiles(path);
    if (!/\.tsx?$/.test(name) || /\.(test|spec)\./.test(name) || /^[_+]/.test(name)) return [];
    // Expo Router screens are the files with a default export.
    return /export default|export \{ default \}/.test(readFileSync(path, 'utf8')) ? [path] : [];
  });
}
it('allowlists every app route as a pattern, so a new screen cannot go unmeasured', () => {
  const routes = routeFiles(app).map((path) =>
    funnelScreenFromSegments(relative(app, path).replace(/\.tsx?$/, '').split('/')),
  );
  expect(routes.length).toBeGreaterThan(20);
  expect(routes).not.toContain(null);
  expect([...new Set(routes)].sort()).toEqual([...FUNNEL_SCREENS].sort());
});
