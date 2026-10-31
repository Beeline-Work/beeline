import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { relative, resolve } from 'node:path';
import v8 from '@vitest/coverage-v8';
import { V8CoverageProvider } from '@vitest/coverage-v8/dist/provider.js';

// Vitest's per-suite coverage packets retain the test-file attribution that
// its ordinary aggregate coverage report discards. Keep the pinned provider's
// source-map conversion so locations refer to TypeScript, not transformed JS.
class FunctionCoverageProvider extends V8CoverageProvider {
  async generateCoverage() {
    await Promise.all(this.pendingPromises);
    const root = resolve(this.ctx.config.root, '../..');
    const entries = [];
    for (const [projectName, modes] of this.coverageFiles) {
      for (const [mode, packets] of Object.entries(modes)) {
        for (const [testNames, filename] of Object.entries(packets)) {
          const packet = JSON.parse(await readFile(filename, 'utf8'));
          const map = await this.convertCoverage(packet, this.ctx.getProjectByName(projectName), mode);
          const functions = [];
          for (const filename of map.files()) {
            const file = relative(root, filename);
            if (!file.startsWith('apps/server/src/') || /\.test\.[cm]?[jt]sx?$/.test(file)) continue;
            const coverage = map.fileCoverageFor(filename).toJSON();
            for (const [id, fn] of Object.entries(coverage.fnMap)) {
              functions.push({ file, start: fn.loc.start.line, end: fn.loc.end.line, covered: coverage.f[id] > 0 });
            }
          }
          for (const filename of testNames.split(',')) entries.push({ test: relative(root, filename), functions });
        }
      }
    }
    const directory = process.env.BEELINE_FUNCTION_COVERAGE_DIR;
    if (!directory) throw new Error('BEELINE_FUNCTION_COVERAGE_DIR is required');
    await mkdir(directory, { recursive: true });
    const key = createHash('sha256').update(JSON.stringify(entries.map(e => e.test))).digest('hex');
    await writeFile(resolve(directory, `${key}-${process.pid}.json`), JSON.stringify(entries));
    return this.createCoverageMap();
  }
  async generateReports() {}
}

export default { ...v8, getProvider: () => new FunctionCoverageProvider() };
