#!/usr/bin/env node
import { readFile } from 'node:fs/promises';

// Use the active Beeline turn. The server owns identity, provenance and GitHub access.
try {
  const { BEELINE_DAEMON_BASE_URL: baseUrl, BEELINE_DAEMON_TOKEN: token,
    BEELINE_DAEMON_AGENT_ID: agentId, BEELINE_TURN_CONTEXT_FILE: contextFile } = process.env;
  if (!baseUrl || !token || !agentId || !contextFile)
    throw new Error('Production release requires an authenticated Beeline agent turn');
  const context = JSON.parse(await readFile(contextFile, 'utf8'));
  const inputs = {};
  const args = process.argv.slice(2);
  for (let index = 0; index < args.length; index += 2) {
    const field = args[index + 1];
    if (!['-f', '-F', '--raw-field', '--field'].includes(args[index]) || !field?.includes('='))
      throw new Error('Use -f name=value for release recovery inputs');
    const separator = field.indexOf('=');
    inputs[field.slice(0, separator)] = field.slice(separator + 1);
  }
  const response = await fetch(new URL('/v1/daemon/operations/dispatchRoomWorkflow', baseUrl), {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ agentId, roomId: context.roomId, requestId: context.requestId,
      generationId: context.generationId, inputs }), signal: AbortSignal.timeout(120000),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error?.message ?? result.error ?? 'Production release dispatch was refused');
  console.log(`Production release dispatched. Audit message: ${result.auditMessageId}`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
