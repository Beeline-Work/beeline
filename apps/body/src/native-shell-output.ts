/** The hook runs inside the native harness, before its result reaches the model. */
export const NATIVE_SHELL_OUTPUT_CAP = 16_384;

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
  const harness = process.argv[2];
  if (harness !== 'claude') {
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
    console.log(JSON.stringify(harness === 'cursor' ? { updated_input: updated } : {
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', updatedInput: updated }
    }));
    return;
  }
  if (event.tool_name !== 'Bash' || !event.tool_response) { console.log('{}'); return; }
  const result = event.tool_response;
  const text = typeof result === 'string' ? result :
    typeof result.stdout === 'string' ? result.stdout + (result.stderr || '') : JSON.stringify(result);
  const cap = 16384;
  if (Buffer.byteLength(text) <= cap) { console.log('{}'); return; }
  let file = result.persistedOutputPath;
  if (!file) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'beeline-shell-output-'));
    fs.chmodSync(directory, 0o700);
    file = path.join(directory, 'output.txt');
    fs.writeFileSync(file, text, { mode: 0o600, flag: 'wx' });
  }
  const notice = '\n[Shell output capped; full output: ' + file + '. Read a bounded range to recover omitted text.]\n';
  const size = Math.floor((cap - Buffer.byteLength(notice) - 9) / 6);
  const bytes = Buffer.from(text);
  const first = bytes.subarray(0, size).toString('utf8').replace(/\uFFFD$/u, '');
  const last = bytes.subarray(-size).toString('utf8').replace(/^\uFFFD+/u, '');
  const preview = notice + first + '\n[...]\n' + last;
  const output = {
    hookSpecificOutput: { hookEventName: 'PostToolUse',
      updatedToolOutput: { ...result, stdout: preview, stderr: '' } }
  };
  process.stdout.write(JSON.stringify(output));
});
`;

export function nativeShellHookCommand(script: string, harness: 'claude' | 'codex' | 'cursor'): string {
  const quote = (text: string) => `'${text.replaceAll("'", String.fromCharCode(39, 92, 39, 39))}'`;
  return `${quote(process.execPath)} ${quote(script)} ${harness}`;
}

export function nativeShellHookConfig(command: string, event: 'PreToolUse' | 'PostToolUse' = 'PostToolUse') {
  return { hooks: { [event]: [{ matcher: '^Bash$', hooks: [{ type: 'command', command }] }] } };
}
