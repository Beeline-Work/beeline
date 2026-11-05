import { AGENT_BEHAVIORS } from './agent-command.js';

// Standalone: native hooks cannot import the helper's dependency tree.
export const NATIVE_SHELL_OUTPUT_SCRIPT = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
if (process.argv[2] === 'stream') {
  const file = process.argv[3];
  const fd = fs.openSync(file, 'w', 0o600);
  const notice = Buffer.from('\n[Shell output capped; full output: ' + file + '. Read a bounded range to recover omitted text.]\n');
  const size = 1024;
  let shown = 0, tail = Buffer.alloc(0), capped = false;
  process.stdin.on('data', chunk => {
    fs.writeSync(fd, chunk);
    const head = chunk.subarray(0, Math.max(0, size - shown));
    if (head.length) { process.stdout.write(head); shown += head.length; }
    const rest = chunk.subarray(head.length);
    if (rest.length) {
      if (!capped) { process.stdout.write(notice); capped = true; }
      tail = Buffer.concat([tail, rest]).subarray(-size);
    }
  });
  process.stdin.on('end', () => {
    fs.closeSync(fd);
    if (capped) process.stdout.write(tail);
  });
  return;
}
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  const event = JSON.parse(input);
  const outputFormats = ${JSON.stringify(Object.fromEntries(Object.entries(AGENT_BEHAVIORS).map(([kind, behavior]) => [kind, behavior.nativeShellHook?.output])))};
  const outputFormat = outputFormats[process.argv[2]];
  if (!['Bash', 'Shell'].includes(event.tool_name) || typeof event.tool_input?.command !== 'string') { console.log('{}'); return; }
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'beeline-shell-output-'));
  fs.chmodSync(directory, 0o700);
  const quote = text => "'" + text.replaceAll("'", String.fromCharCode(39, 92, 39, 39)) + "'";
  const output = path.join(directory, 'output.txt'), status = path.join(directory, 'status');
  // Each native invocation has its own shell. Keep its shell language, stdin
  // and exit status, and wait for the capper before returning the result.
  const command = '(\n(\n' + event.tool_input.command + '\n)\n_beeline_output_status=$?\nprintf "%s" "$_beeline_output_status" > ' + quote(status) +
    '\n) 2>&1 | ' + quote(process.execPath) + ' ' + quote(__filename) + ' stream ' + quote(output) +
    '\nexit "$(' + '/bin/cat ' + quote(status) + ')"';
  const updated = { ...event.tool_input, command };
  console.log(JSON.stringify(outputFormat === 'updated-input' ? { updated_input: updated } : {
    hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: updated }
  }));
  return;
});
`;

export function nativeShellHookCommand(script: string, harness: 'claude' | 'codex' | 'cursor'): string {
  const quote = (text: string) => `'${text.replaceAll("'", String.fromCharCode(39, 92, 39, 39))}'`;
  return `${quote(process.execPath)} ${quote(script)} ${harness}`;
}

export function nativeShellHookConfig(command: string, event: 'PreToolUse' | 'PostToolUse' = 'PreToolUse') {
  return { hooks: { [event]: [{ matcher: '^Bash$', hooks: [{ type: 'command', command }] }] } };
}
