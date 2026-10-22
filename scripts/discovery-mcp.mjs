/** Audit the real MCP wire; never forward deliberately unsafe eval operations. */
import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { isUnsafeDiscoveryCall } from './discovery-policy.mjs';
const target = process.argv[2];
const trace = process.argv[3] ?? process.env.BEELINE_DISCOVERY_TRACE;
const room = process.argv[4];
if (!target || !trace || !room)
    throw new Error('Missing eval target, trace or fixture Room');
const child = spawn(process.execPath, [target], { env: process.env, stdio: ['pipe', 'pipe', 'inherit'] });
const pending = new Map();
createInterface({ input: child.stdout }).on('line', (line) => {
    let message;
    try {
        message = JSON.parse(line);
    }
    catch {
        process.stdout.write(`${line}\n`);
        return;
    }
    if (pending.has(message.id)) {
        appendFileSync(trace, `${JSON.stringify({ type: 'result', id: message.id, result: message.result, error: message.error })}\n`);
        pending.delete(message.id);
    }
    process.stdout.write(`${line}\n`);
});
createInterface({ input: process.stdin }).on('line', (line) => {
    let message;
    try {
        message = JSON.parse(line);
    }
    catch {
        child.stdin.write(`${line}\n`);
        return;
    }
    if (message.method === 'tools/call') {
        const { name, arguments: args = {} } = message.params;
        const unsafe = isUnsafeDiscoveryCall(name, args, room);
        appendFileSync(trace, `${JSON.stringify({ type: 'call', id: message.id, name, args, intendedOnly: unsafe })}\n`);
        if (unsafe) {
            process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: '{"eval":"intended call recorded; operation not executed"}' }] } })}\n`);
            return;
        }
    }
    if (message.method === 'tools/call')
        pending.set(message.id, true);
    child.stdin.write(`${line}\n`);
});
process.stdin.on('end', () => child.stdin.end());
process.on('SIGTERM', () => child.kill('SIGTERM'));
child.on('exit', (code) => process.exit(code ?? 1));
