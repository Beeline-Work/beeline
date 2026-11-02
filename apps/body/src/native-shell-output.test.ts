import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import { NATIVE_SHELL_OUTPUT_CAP, NATIVE_SHELL_OUTPUT_SCRIPT, nativeShellHookCommand } from './native-shell-output.js';
const exec = promisify(execFile);

it.each(['claude', 'codex', 'cursor'])(
  'SHELL-CAP: %s native hook caps a command and recovers the full output',
  async (harness) => {
    const directory = await mkdtemp(join(tmpdir(), 'native-shell-proof-'));
    try {
      const hook = join(directory, 'hook.cjs');
      await writeFile(hook, NATIVE_SHELL_OUTPUT_SCRIPT);
      const command = `${JSON.stringify(process.execPath)} -e 'process.stdout.write("HEAD\\n"+"x".repeat(400000)+"\\nTAIL\\n");process.exitCode=7'`;
      const original = await exec('bash', ['-c', command]).catch((error) => error);
      expect(original.code).toBe(7);
      const input = JSON.stringify({
        tool_name: harness === 'cursor' ? 'Shell' : 'Bash',
        tool_input: { command },

      });
      const result = await new Promise<string>((resolve, reject) => {
        const child = execFile(
          process.execPath,
          [hook, harness],
          { env: { ...process.env, TMPDIR: directory } },
          (error, stdout) => (error ? reject(error) : resolve(stdout)),
        );
        child.stdin!.end(input);
      });
      const parsed = JSON.parse(result);
      expect(parsed.hookSpecificOutput ?? {}).not.toHaveProperty('permissionDecision');
      const execution = await exec('bash', [
        '-c',
        (harness === 'cursor' ? parsed.updated_input : parsed.hookSpecificOutput.updatedInput).command,
      ]).catch((error) => error);
      expect(execution.code).toBe(7);
      const output = execution.stdout;
      expect(Buffer.byteLength(output)).toBeLessThanOrEqual(NATIVE_SHELL_OUTPUT_CAP);
      expect(output).toContain('HEAD');
      expect(output).toContain('TAIL');
      const file = /full output: (.*)\. Read a bounded/.exec(output)![1]!;
      expect(await readFile(file, 'utf8')).toBe('HEAD\n' + 'x'.repeat(400000) + '\nTAIL\n');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

it.each(['claude', 'codex', 'cursor'])('keeps an interactive stdin prompt visible in %s', async harness => {
  const directory = await mkdtemp(join(tmpdir(), 'native-shell-stdin-'));
  try {
    const hook = join(directory, 'hook.cjs');
    await writeFile(hook, NATIVE_SHELL_OUTPUT_SCRIPT);
    const response = await new Promise<string>((resolve, reject) => {
      const child = execFile(process.execPath, [hook, harness], { env: { ...process.env, TMPDIR: directory } },
        (error, stdout) => error ? reject(error) : resolve(stdout));
      child.stdin!.end(JSON.stringify({ tool_name: harness === 'cursor' ? 'Shell' : 'Bash',
        tool_input: { command: 'printf "prompt> "; read -r _beeline_reply; printf "%s" "$_beeline_reply"' } }));
    });
    const parsed = JSON.parse(response);
    const command = (harness === 'cursor' ? parsed.updated_input : parsed.hookSpecificOutput.updatedInput).command;
    const result = await new Promise<string>((resolve, reject) => {
      const child = execFile('bash', ['-c', command], { timeout: 3000 }, (error, stdout) => error ? reject(error) : resolve(stdout));
      child.stdout!.once('data', () => child.stdin!.end('hello\n'));
    });
    expect(result).toBe('prompt> hello');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it('quotes generated hook commands containing apostrophes', async () => {
  const directory = await mkdtemp(join(tmpdir(), "native-shell-quote-'"));
  try {
    const hook = join(directory, 'hook.cjs');
    await writeFile(hook, NATIVE_SHELL_OUTPUT_SCRIPT);
    const response = await new Promise<string>((resolve, reject) => {
      const child = execFile('bash', ['-c', nativeShellHookCommand(hook, 'claude')],
        (error, stdout) => error ? reject(error) : resolve(stdout));
      child.stdin!.end(JSON.stringify({ tool_name: 'Read' }));
    });
    expect(JSON.parse(response)).toEqual({});
  } finally { await rm(directory, { recursive: true, force: true }); }
});
