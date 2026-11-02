import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { AcpClient, openAcpConversation } from './acp.js';
import { assembleTurnPrompt } from './prompt-assembly.js';

it.each(['2.3.0', 'unknown'])('Codex ACP delivery and recovery, adapter %s', async version => {
  const directory = await mkdtemp(join(tmpdir(), 'codex-block-wire-'));
  const script = join(directory, 'adapter.cjs');
  await writeFile(script, `
const rl = require('node:readline').createInterface({input: process.stdin});
rl.on('line', line => {
  const {id, method, params} = JSON.parse(line);
  if (id === undefined) return;
  const send = result => process.stdout.write(JSON.stringify({jsonrpc:'2.0', id, result})+'\\n');
  const update = update => process.stdout.write(JSON.stringify({jsonrpc:'2.0',method:'session/update',params:{sessionId:'new',update}})+'\\n');
  if (method === 'initialize') {
    if (!params.clientCapabilities.session.compaction) throw Error('missing compaction capability');
    send({protocolVersion:1,agentInfo:{version:${JSON.stringify(version)}},agentCapabilities:{loadSession:true,sessionCapabilities:{systemPrompt:{}}}});
  } else if (method === 'session/new') send({sessionId:'new'});
  else if (method === 'session/load') {
    if (params.sessionId === 'lost') process.stdout.write(JSON.stringify({jsonrpc:'2.0',id,error:{code:-32000,message:'session missing'}})+'\\n');
    else send({});
  } else if (method === 'session/prompt') {
    const text = params.prompt[0].text;
    if (text.includes('compact now')) update({sessionUpdate:'compaction_update',compactionId:'c1',status:'completed'});
    update({sessionUpdate:'agent_message_chunk',content:{type:'text',text}});
    send({stopReason:'end_turn'});
  }
});
`);
  const client = new AcpClient({ agentCommand: process.execPath, agentArgs: [script],
    agentLabel: 'codex-acp', agentEnv: {}, resourceScope: 'none' });
  try {
    await client.start();
    const { sessionId } = await client.sessionNew({ cwd: directory, systemPrompt: 'Rules' });
    const prompt = (body = 'hello') => assembleTurnPrompt({ surface: 'room',
      sessionPrefix: 'Rules', members: 'Members: @bee', memory: 'Memory: tea',
      task: { body }, delivery: client.promptDelivery(sessionId) });
    const first = prompt();
    expect(first.text.includes('Rules')).toBe(version !== '2.3.0');
    expect(first.text).toContain('Members: @bee');
    expect((await client.sessionPrompt(sessionId, first.text)).agentText).toBe(first.text);
    const warm = prompt();
    expect(warm.text.includes('Members: @bee')).toBe(version !== '2.3.0');
    await client.sessionPrompt(sessionId, warm.text);
    await client.sessionPrompt(sessionId, prompt('compact now').text);
    expect(prompt().text).toContain('Rules');
    expect(prompt().text).toContain('Members: @bee');
    // A native load has no delivery baseline, even when its id is unchanged.
    await client.sessionLoad({ sessionId, cwd: directory });
    expect(prompt().text).toContain('Rules');
    expect(prompt().text).toContain('Memory: tea');
    const fallback = await openAcpConversation({ client, agentCommand: 'codex-acp',
      resumeSessionId: 'lost', cwd: directory,
      create: () => client.sessionNew({ cwd: directory, systemPrompt: 'Rules' }) });
    expect(fallback.kind).toBe('created');
    expect(prompt().text).toContain('Members: @bee');
    // Rules arrive via session/new, or remain in the prompt for unknown versions.
    expect(prompt().text.includes('Rules')).toBe(version !== '2.3.0');
  } finally { await client.stop(); await rm(directory, { recursive: true, force: true }); }
});
