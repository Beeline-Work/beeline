/** Keep the normal Grok harness and login, exposing only Beeline-owned skills. */
import { readdir, rm } from 'node:fs/promises';
import { resolve, relative, isAbsolute, join } from 'node:path';
import { spawn } from 'node:child_process';
import { beelineManagedSkills } from '../apps/body/dist/beeline-skill.js';
const home = resolve(process.env.GROK_HOME ?? '');
const root = process.env.BEELINE_DISCOVERY_HOME_ROOT;
const suffix = root ? relative(resolve(root), home) : '..';
if (!root || suffix === '..' || suffix.startsWith('../') || isAbsolute(suffix))
    throw new Error('Eval skill filter requires an isolated harness home');
const permitted = new Set(beelineManagedSkills('source', { isReviewer: false }).map((s) => s.name));
for (const entry of await readdir(join(home, 'skills'))) {
    if (!permitted.has(entry))
        await rm(join(home, 'skills', entry), { recursive: true, force: true });
}
const child = spawn(process.env.BEELINE_DISCOVERY_GROK ?? 'grok', process.argv.slice(2), { stdio: 'inherit', env: process.env });
process.on('SIGTERM', () => child.kill('SIGTERM'));
process.on('SIGINT', () => child.kill('SIGINT'));
child.on('error', (error) => { console.error(error.message); process.exit(1); });
child.on('exit', (code) => process.exit(code ?? 1));
