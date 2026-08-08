import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

import { describe, expect, it } from 'vitest';

describe('Metro monorepo paths', () => {
  it('omits node_modules directories that do not exist', () => {
    const mobileDir = '/project/apps/mobile';
    const mobileNodeModules = path.join(mobileDir, 'node_modules');
    const packagesDir = path.resolve(mobileDir, '../../packages');
    const existingPaths = new Set([mobileNodeModules, packagesDir]);
    const module = { exports: {} as Record<string, unknown> };

    const mockRequire = Object.assign(
      (id: string) => {
        if (id === 'expo/metro-config') {
          return {
            getDefaultConfig: () => ({
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
    });

    const config = module.exports as {
      resolver: { nodeModulesPaths: string[] };
      watchFolders: string[];
    };
    expect(config.watchFolders).toEqual([packagesDir]);
    expect(config.resolver.nodeModulesPaths).toEqual([mobileNodeModules]);
  });
});
