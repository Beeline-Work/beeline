import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);

/**
 * Expo Router makes a route of every default-exporting file under `app/`, so a
 * screen kept beside its own route file becomes a second URL for the same
 * screen — reachable, unlinked, and free to drift. The route table Expo
 * generates is what decides that, so ask the table rather than the source.
 */
async function generatedRoutes(): Promise<string> {
  const appRoot = path.join(__dirname, '../..');
  const outputDir = mkdtempSync(path.join(tmpdir(), 'router-types-'));
  process.env.EXPO_ROUTER_APP_ROOT = appRoot;
  try {
    const { regenerateDeclarations } = require('@expo/router-server/build/typed-routes');
    regenerateDeclarations(outputDir);
    const declaration = path.join(outputDir, 'router.d.ts');
    // Expo debounces generation to coalesce Metro filesystem events.
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      const contents = safeRead(declaration);
      if (contents) return contents;
    }
    throw new Error('Expo Router did not generate router.d.ts');
  } finally {
    rmSync(outputDir, { recursive: true, force: true });
  }
}

function safeRead(file: string): string | null {
  try {
    const contents = readFileSync(file, 'utf8');
    return contents.length > 0 ? contents : null;
  } catch {
    return null;
  }
}

describe('members route', () => {
  it('reaches the members screen at one URL only', async () => {
    const routes = await generatedRoutes();
    expect(routes).toContain('/beeline/members');
    expect(routes).not.toContain('MembersScreen');
  }, 20_000);

  it('is registered once in the app stack', () => {
    const layout = readFileSync(new URL('../_layout.tsx', import.meta.url), 'utf8');
    const registrations = layout.match(/name="beeline\/[Mm]embers[A-Za-z]*"/g) ?? [];
    expect(registrations).toEqual(['name="beeline/members"']);
  });
});
