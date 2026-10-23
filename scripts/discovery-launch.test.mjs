import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
test('only Beeline skills survive before the normal harness launches', async () => {
    const root = await mkdtemp(join(tmpdir(), 'discovery-skills-'));
    const home = join(root, 'cursor');
    try {
        for (const name of ['beeline-files-and-mocks', 'external-skill', 'draw-avatar']) {
            await mkdir(join(home, 'skills', name), { recursive: true });
            await writeFile(join(home, 'skills', name, 'SKILL.md'), 'fixture');
        }
        const env = { ...process.env, CURSOR_HOME: home, BEELINE_DISCOVERY_HOME_ROOT: root, BEELINE_DISCOVERY_EXECUTABLE: process.execPath };
        const result = execFileSync(process.execPath, [resolve('scripts/discovery-launch.mjs'), '-e', 'process.stdout.write("normal-launch")'], { env, encoding: 'utf8' });
        assert.equal(result, 'normal-launch');
        assert.deepEqual(await readdir(join(home, 'skills')), ['beeline-files-and-mocks']);
        assert.throws(() => execFileSync(process.execPath, [resolve('scripts/discovery-launch.mjs')], { env: { ...env, BEELINE_DISCOVERY_HOME_ROOT: join(root, 'other') }, stdio: 'pipe' }), /Command failed/);
    }
    finally {
        await rm(root, { recursive: true, force: true });
    }
});
