import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

import { describe, expect, it } from 'vitest';

describe('Metro monorepo paths', () => {
  it.each([undefined, '0', '1'])('resolves paths and isolates measurement cache (flag %s)', (measure) => {
    const mobileDir = '/project/apps/mobile';
    const mobileNodeModules = path.join(mobileDir, 'node_modules');
    const packagesDir = path.resolve(mobileDir, '../../packages');
    const existingPaths = new Set([mobileNodeModules, packagesDir]);
    const module = { exports: {} as Record<string, unknown> };

    const mockRequire = Object.assign(
      (id: string) => {
        if (id === '@sentry/react-native/metro') {
          return {
            getSentryExpoConfig: () => ({
              cacheVersion: 'expo-default',
              resolver: { assetExts: [] as string[] },
              transformer: {},
            }),
          };
        }
        if (id === 'fs') {
          return { existsSync: (candidate: string) => existingPaths.has(candidate) };
        }
        if (id === 'path') {
          return path;
        }
        throw new Error(`Unexpected require: ${id}`);
      },
      { resolve: (id: string) => `/mock/${id}` },
    );

    const source = readFileSync(new URL('../../metro.config.js', import.meta.url), 'utf8');
    vm.runInNewContext(source, {
      __dirname: mobileDir,
      exports: module.exports,
      module,
      require: mockRequire,
      process: { env: { BEELINE_TRANSCRIPT_MEASURE: measure } },
    });

    const config = module.exports as {
      cacheVersion: string;
      resolver: { blockList: RegExp[]; nodeModulesPaths: string[] };
      watchFolders: string[];
    };
    expect(config.cacheVersion).toBe(measure === '1' ? 'expo-default-transcript-measure' : 'expo-default');
    expect(config.watchFolders).toEqual([packagesDir]);
    expect(config.resolver.nodeModulesPaths).toEqual([mobileNodeModules]);
    const [tauriBuilds, testSources] = config.resolver.blockList;
    expect(tauriBuilds.test('/project/apps/mobile/src-tauri/target/debug/app')).toBe(true);
    expect(testSources.test('/project/apps/mobile/sources/foo.test.ts')).toBe(true);
    expect(testSources.test('/project/apps/mobile/sources/foo.test.tsx')).toBe(true);
    expect(testSources.test('/project/apps/mobile/sources/foo.spec.ts')).toBe(true);
    expect(testSources.test('/project/apps/mobile/sources/__tests__/foo.ts')).toBe(true);
    expect(testSources.test('/project/apps/mobile/sources/foo.ts')).toBe(false);
  });
});
