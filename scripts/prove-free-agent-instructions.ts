/** Content-free ACP replay. Run with node --import tsx; Python needs tiktoken.
 * TOKENIZER_PYTHONPATH may name an isolated Python dependency directory. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AcpClient } from '../apps/body/src/acp.js';
import { assembleSessionPrompt } from '../apps/body/src/prompt-assembly.js';
import { freeAgentInstructions } from '../apps/server/src/free-agents.js';

async function main(): Promise<void> {
const root = await mkdtemp(join(tmpdir(), 'beeline-pi-token-proof-'));
const harness = join(root, 'harness.cjs');
const capture = join(root, 'prompts.jsonl');
const instructions = assembleSessionPrompt({ surface: 'room', agentName: 'Beebee', agentCommand: 'pi-acp',
  shell: { available: true }, machineHost: { hostname: 'fixture' },
  soul: { name: 'Beebee', instructions: freeAgentInstructions('Be concise and do the assigned task.', 'Beebee',
    { cpus: 1, memoryMb: 2048 } as Parameters<typeof freeAgentInstructions>[2]) } }).systemPrompt;
// This harness only records ACP transport. It neither calls a model nor runs
// user tools. Actual task content and model task quality are not replayed.
await writeFile(harness, `const fs=require('fs'),rl=require('readline');
const send=x=>process.stdout.write(JSON.stringify(x)+'\\n');
rl.createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);if(m.id===undefined)return;let result={};
 if(m.method==='initialize')result={protocolVersion:1,agentCapabilities:{promptCapabilities:{image:true}}};
 if(m.method==='session/new')result={sessionId:'session'};
 if(m.method==='session/prompt'){
  fs.appendFileSync(process.env.CAPTURE,JSON.stringify(m.params.prompt)+'\\n');
  send({jsonrpc:'2.0',method:'session/update',params:{sessionId:'session',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'Task delivered.'}}}});
  result={stopReason:'end_turn'};
 }
 send({jsonrpc:'2.0',id:m.id,result});
});`);
const journalDir = join(root, 'sessions/project');
await mkdir(journalDir, { recursive: true });
const journal = join(journalDir, 'time_session.jsonl');
await writeFile(journal, '{"type":"session","id":"session"}\n');
const client = new AcpClient({ agentCommand: process.execPath, agentArgs: [harness], agentLabel: 'pi-acp',
  agentEnv: { PI_CODING_AGENT_DIR: root, CAPTURE: capture }, resourceScope: 'none', agentCwd: root });
try {
  await client.start();
  await client.sessionNew({ cwd: root, systemPrompt: instructions });
  const calls = [12, 2, 2, 1, 1, 10, 5, 4, 1, 8, 18, 1, 1, 6, 1, 5];
  // Scale neutral retained history to SUB0ZERO-size context. Only policy
  // duplication changes; all tasks and tool-result stand-ins are identical.
  let before = 'Archived task context. '.repeat(25_000);
  let after = before;
  const pairs: { turn: number; call: number; before: string; after: string }[] = [];
  for (let turn = 0; turn < calls.length; turn++) {
    const task = `Task ${turn + 1}: preserve the approved outcome.`;
    const original = `${instructions}\n\n${task}`;
    const result = await client.sessionPrompt('session', original, 5_000);
    assert.equal(result.agentText, 'Task delivered.');
    const prompts = (await readFile(capture, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    const delivered = prompts.at(-1)[0].text as string;
    assert.equal(delivered, turn === 0 ? original : task);
    before += `\n\n${original}`;
    after += `\n\n${delivered}`;
    for (let call = 1; call <= calls[turn]!; call++) {
      pairs.push({ turn: turn + 1, call, before, after });
      const progress = `\nTool result: task ${turn + 1}, step ${call} completed.`;
      before += progress;
      after += progress;
    }
  }
  // Exact task/tool history equality after removing redundant rule copies.
  const taskHistory = (text: string) => text.split(instructions).join('').replace(/\n{3,}/g, '\n\n');
  assert.equal(taskHistory(before), taskHistory(after));
  await writeFile(journal, '{"type":"compaction","id":"compacted"}\n');
  await client.sessionPrompt('session', [{ type: 'text', text: 'Continue after compaction.' },
    { type: 'image', mimeType: 'image/png', data: 'AA==' }], 5_000);
  const restored = JSON.parse((await readFile(capture, 'utf8')).trim().split('\n').at(-1)!);
  assert.equal(restored[0].text, `${instructions}\n\nContinue after compaction.`);
  assert.deepEqual(restored[1], { type: 'image', mimeType: 'image/png', data: 'AA==' });
  const counts = JSON.parse(execFileSync('python3', ['-c', `import sys,json,tiktoken
e=tiktoken.get_encoding('o200k_base')
print(json.dumps([[len(e.encode(x['before'])),len(e.encode(x['after']))] for x in json.load(sys.stdin)]))`],
    { input: JSON.stringify(pairs), maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, ...(process.env.TOKENIZER_PYTHONPATH ? { PYTHONPATH: process.env.TOKENIZER_PYTHONPATH } : {}) } }).toString());
  console.log('Reproduction SUB0ZERO-Pi-prefix: synthetic retained history, 16 turns / 78 model-call contexts, o200k_base.');
  console.log('turn,call,before_input_tokens,after_input_tokens,saved');
  for (let i = 0; i < pairs.length; i++) console.log([pairs[i]!.turn, pairs[i]!.call, ...counts[i], counts[i][0] - counts[i][1]].join(','));
  const totals = counts.reduce((sum: number[], pair: number[]) => [sum[0]! + pair[0]!, sum[1]! + pair[1]!], [0, 0]);
  console.log(JSON.stringify({ totals, saved: totals[0] - totals[1], taskHistoryUnchanged: true,
    compactionRestoredRules: true, imageBlockUnchanged: true, realModelQualityProven: false }));
} finally {
  await client.stop();
  await rm(root, { recursive: true, force: true });
}
}

main().catch(error => { console.error(error); process.exitCode = 1; });
