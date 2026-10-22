// One command routes future jobs back to GitHub-hosted; submit this diff as a PR.
import { readFileSync, writeFileSync } from 'node:fs';
const file = new URL('../../.github/workflows/checks.yml', import.meta.url);
const workflow = readFileSync(file, 'utf8');
const changed = workflow.replace(/^    runs-on: .*'squire-ci'.*$/gm, '    runs-on: ubuntu-latest');
if (changed === workflow) throw new Error('No overflow routing found');
writeFileSync(file, changed);
