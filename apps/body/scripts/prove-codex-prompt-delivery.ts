/** Real Codex ACP proof. No config writes, tool restrictions or model overrides.
 * Uses the current agent's inherited login and a disposable working directory.
 * Run: npm run prove:codex-prompt-delivery -w @beeline/body
 */
import { appendFile, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { AcpClient } from '../src/acp.js';
import { assembleSessionPrompt, assembleTurnPrompt, type TurnPromptContext } from '../src/prompt-assembly.js';

async function savePrompt(mode: string, turn: string, text: string): Promise<void> {
  if (process.env.BEELINE_CODEX_PROOF_OUTPUT)
    await appendFile(process.env.BEELINE_CODEX_PROOF_OUTPUT, JSON.stringify({ mode, turn, text }) + '\n');
}
const cwd = await mkdtemp(join(tmpdir(), 'beeline-codex-delivery-proof-'));
const env = Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined));
// Read only this proof's own session journal, never another agent's files.
async function usage(session: string): Promise<unknown> {
  const root = join(env.CODEX_HOME ?? join(env.HOME!, '.codex'), 'sessions');
  async function find(directory: string): Promise<string | undefined> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) { const found = await find(join(directory, entry.name)); if (found) return found; }
      else if (entry.name.endsWith(`${session}.jsonl`)) return join(directory, entry.name);
    }
  }
  const file = await find(root);
  if (!file) return undefined;
  const rows = (await readFile(file, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  return rows.filter(row => row.type === 'event_msg' && row.payload?.type === 'token_count')
    .at(-1)?.payload?.info?.last_token_usage;
}
const sessionPrompt = assembleSessionPrompt({ surface: 'room', agentName: 'ProofBee',
  agentCommand: 'codex-acp', shell: { available: true },
  soul: { name: 'ProofBee', instructions: 'For this delivery proof, answer with the current proof word only. The initial proof word is AMBER.' } });
const base: TurnPromptContext = { surface: 'room', sessionPrefix: sessionPrompt.turnPrefix,
  members: 'Members (exact tag spellings):\n- @owner (person)\nYou are @proofbee.',
  memory: 'Memory (quoted notes):\nThe current proof word is AMBER.',
  corners: Array.from({ length: 12 }, (_, i) => ({ cornerId: `fixture-corner-${i}`, parentRoomId: 'fixture-room',
    name: `fixture-${i}`, objective: 'A stable proof fixture for unchanged corner delivery.', createdBy: 'owner', archived: false })),
  task: { body: 'Return the current proof word only. Do not use tools.' } };

try {
  for (const mode of ['before', 'after'] as const) {
    const client = new AcpClient({ agentCommand: 'codex-acp', agentLabel: 'codex-acp',
      agentEnv: env, agentCwd: cwd, resourceScope: 'none' });
    try {
      await client.start();
      const { sessionId } = await client.sessionNew({ cwd, systemPrompt: sessionPrompt.systemPrompt });
      await savePrompt(mode, 'session', sessionPrompt.systemPrompt);
      if (mode === 'after') assert(client.promptDelivery(sessionId), 'Verified Codex delivery path was not activated');
      for (const turn of ['first', 'warm', 'changed'] as const) {
        const assembled = assembleTurnPrompt({ ...base,
          ...(turn === 'changed' ? { memory: 'Memory (quoted notes):\nThe current proof word is COBALT.' } : {}),
          ...(mode === 'after' ? { delivery: client.promptDelivery(sessionId) } : {}) });
        await savePrompt(mode, turn, assembled.text);
        const result = await client.sessionPrompt(sessionId, assembled.text, 180_000);
        const expected = turn === 'changed' ? 'COBALT' : 'AMBER';
        assert.equal(result.agentText.trim(), expected);
        console.log(JSON.stringify({ mode, turn, promptBytes: Buffer.byteLength(assembled.text),
          sections: assembled.report.map(s => s.id), reply: result.agentText.trim(),
          tokens: await usage(sessionId), acpTokens: result.tokenUsage }));
      }
      if (mode === 'after') {
        const compacted = await client.sessionPrompt(sessionId, '/compact', 180_000);
        assert(compacted.updates.some(event => event.update.sessionUpdate === 'compaction_update'), 'Real adapter did not report compaction');
        const restored = assembleTurnPrompt({ ...base,
          memory: 'Memory (quoted notes):\nThe current proof word is COBALT.',
          delivery: client.promptDelivery(sessionId) });
        assert(restored.text.includes(sessionPrompt.turnPrefix));
        assert(restored.text.includes('Members (exact tag spellings)'));
        await savePrompt(mode, 'after-compaction', restored.text);
        const result = await client.sessionPrompt(sessionId, restored.text, 180_000);
        assert.equal(result.agentText.trim(), 'COBALT');
        console.log(JSON.stringify({ mode, turn: 'after-compaction',
          promptBytes: Buffer.byteLength(restored.text), sections: restored.report.map(s => s.id),
          reply: result.agentText.trim(), tokens: await usage(sessionId) }));
      }
    } finally { await client.stop(); }
  }
} finally { await rm(cwd, { recursive: true, force: true }); }
