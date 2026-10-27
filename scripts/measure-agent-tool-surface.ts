/** Run with node --import tsx scripts/measure-agent-tool-surface.ts <output-dir>.
 * Tokenize the exact compact JSON files with tiktoken o200k_base; bytes alone are not tokens.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { agentToolsFor } from '../apps/body/src/read-only-mcp.js';

const output = resolve(process.argv[2] ?? '.minimal-surface');
mkdirSync(output, { recursive: true });
const surfaces = {
  room: agentToolsFor(true, false, false, false, true, true, true),
  repository: agentToolsFor(true, false, true, true, true, true, true),
  repoless: agentToolsFor(true, false, true, false, true, true, true),
  dm: agentToolsFor(true, true, false, false, true, true, true),
  // Claude without a Room sandbox: no command runner, one terminal receipt and bounded reads.
  shellless: [
    ...agentToolsFor(false, false),
    ...agentToolsFor(true, false, false, false, false, true, true),
  ],
};
for (const [surface, tools] of Object.entries(surfaces)) {
  const json = JSON.stringify(tools);
  writeFileSync(resolve(output, `${surface}.json`), json);
  console.log(JSON.stringify({ surface, tools: tools.length, bytes: Buffer.byteLength(json) }));
}
// read-only-mcp owns a stdio MCP transport; this offline measurement has no input loop.
process.exit(0);
