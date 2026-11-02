import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import { NATIVE_SHELL_OUTPUT_CAP, NATIVE_SHELL_OUTPUT_SCRIPT } from './native-shell-output.js';
const exec = promisify(execFile);

it.each(['claude', 'codex'])('SHELL-CAP: %s native hook caps a command and recovers the full output', async harness => {
  const directory = await mkdtemp(join(tmpdir(), 'native-shell-proof-'));
  try {
    const hook = join(directory, 'hook.cjs');
    await writeFile(hook, NATIVE_SHELL_OUTPUT_SCRIPT);
    const command = `${JSON.stringify(process.execPath)} -e 'process.stdout.write("HEAD\\n"+"x".repeat(400000)+"\\nTAIL\\n");process.exitCode=7'`;
    const original = await exec('bash', ['-c', command]).catch(error => error);
    expect(original.code).toBe(7);
    const input = JSON.stringify({ tool_name: 'Bash', tool_input: { command }, tool_response: {
      stdout: original.stdout, stderr: original.stderr, interrupted: false, isImage: false,
    } });
    const result = await new Promise<string>((resolve, reject) => {
      const child = execFile(process.execPath, [hook, harness], { env: { ...process.env, TMPDIR: directory } }, (error, stdout) => error ? reject(error) : resolve(stdout));
      child.stdin!.end(input);
    });
    const parsed = JSON.parse(result);
    const execution = harness === 'codex' ? await exec('bash', ['-c', parsed.hookSpecificOutput.updatedInput.command]).catch(error => error) : undefined;
    if (execution) expect(execution.code).toBe(7);
    const output = execution?.stdout ?? parsed.hookSpecificOutput.updatedToolOutput.stdout;
    expect(Buffer.byteLength(output)).toBeLessThanOrEqual(NATIVE_SHELL_OUTPUT_CAP);
    expect(output).toContain('HEAD');
    expect(output).toContain('TAIL');
    const file = /full output: (.*)\. Read a bounded/.exec(output)![1]!;
    expect(await readFile(file, 'utf8')).toBe('HEAD\n' + 'x'.repeat(400000) + '\nTAIL\n');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
