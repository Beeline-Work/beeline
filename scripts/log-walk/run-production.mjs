import { readdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { walk } from './walk.mjs';

// Do not run the DM's walk.mjs. Only read the collector's raw directory.
const root = '/home/lunchbox/.local/state/beeline';
const agents = join(root, 'agents');
const matches = [];
for (const agent of await readdir(agents)) {
  if (!agent.startsWith('c3dfbf8a')) continue;
  const candidate = join(agents, agent, 'rooms', '79efa989-fecd-4276-8ff3-ece8e2cf5a36', 'agent-home', 'user', 'log-walk', 'raw');
  try { matches.push(await realpath(candidate)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
}
if (matches.length !== 1) throw new Error(`Expected exactly one collector directory; found ${matches.length}`);
await walk({ raw: matches[0], state: join(root, 'log-walk-reviewed', 'state'), out: join(process.env.RUNNER_TEMP, 'log-walk-report'), hours: 24 });
