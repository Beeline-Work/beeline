#!/usr/bin/env node
/** Export the complete first-parent history; the comparator selects the last-pass range. */
import { execFileSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
const [repo, head, output] = process.argv.slice(2);
if (!repo || !/^[a-f0-9]{40}$/.test(head ?? '') || !output) throw new Error('Require repository, full head SHA and output JSON path');
const log = execFileSync('git', ['-C', repo, 'log', '--first-parent', '--format=%H%x00%s', head], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
await writeFile(output, JSON.stringify(log.trim().split('\n').filter(Boolean).map((line) => {
  const nul = line.indexOf('\0'); return { sha: line.slice(0, nul), subject: line.slice(nul + 1) };
}), null, 2) + '\n');
