import { COMMAND_WRAPPERS } from '@beeline/api-contract/agent-grants';
import { accessSync, constants, statSync } from 'node:fs';
import { resolve } from 'node:path';

/** Resolve GNU env options without changing the argv sent to the child. */
export function resolveGrantCommand(input: readonly string[], cwd: string, env: NodeJS.ProcessEnv): {
  argv: readonly string[]; cwd: string; env: NodeJS.ProcessEnv;
} {
  const argv = [...input];
  let result = { ...env };
  let head = 0;
  const noValue = ['ignore-environment', 'null', 'debug', 'list-signal-handling', 'help', 'version'];
  const required = ['unset', 'chdir', 'argv0', 'split-string'];
  const optional = ['block-signal', 'default-signal', 'ignore-signal'];
  const names = [...noValue, ...required, ...optional];
  while (COMMAND_WRAPPERS.has(argv[head]?.split('/').pop() ?? '')) {
    const wrapper = argv[head++]!.split('/').pop();
    if (wrapper !== 'env') {
      // Preserve the contract's existing traversal of other command wrappers.
      while (head < argv.length - 1 && (argv[head]!.startsWith('-') || /^[A-Za-z_][A-Za-z0-9_]*=/.test(argv[head]!) || /^\d+$/.test(argv[head]!))) head += 1;
      continue;
    }
    let clear = false;
    const unset: string[] = [];
    let directory: string | undefined;
    const apply = (name: string, value?: string) => {
      if (name === 'ignore-environment') clear = true;
      if (name === 'unset') unset.push(value!);
      if (name === 'chdir') directory = value;
    };
    while (head < argv.length) {
      const word = argv[head]!;
      if (word === '--') { head += 1; break; }
      if (word === '-' || !word.startsWith('-')) break;
      let split: string | undefined;
      if (word.startsWith('--')) {
        const equal = word.indexOf('=');
        const name = word.slice(2, equal < 0 ? undefined : equal);
        const matches = names.includes(name) ? [name] : names.filter(candidate => candidate.startsWith(name));
        if (matches.length !== 1) throw new Error(`env rejects unknown or ambiguous option: ${word}`);
        const full = matches[0]!;
        let value = equal < 0 ? undefined : word.slice(equal + 1);
        if (noValue.includes(full) && value !== undefined) throw new Error(`env option does not take a value: ${word}`);
        if (required.includes(full) && value === undefined) value = argv[++head];
        if (required.includes(full) && value === undefined) throw new Error(`env option is missing its operand: ${word}`);
        if (full === 'help' || full === 'version') return { argv: [], cwd, env: result };
        apply(full, value);
        if (full === 'split-string') split = value;
      } else {
        for (let index = 1; index < word.length; index += 1) {
          const flag = word[index]!;
          const name = ({ i: 'ignore-environment', '0': 'null', v: 'debug', u: 'unset', C: 'chdir', a: 'argv0', S: 'split-string' } as Record<string, string>)[flag];
          if (!name) throw new Error(`env rejects unknown option: -${flag}`);
          let value: string | undefined;
          if (required.includes(name)) {
            value = word.slice(index + 1) || argv[++head];
            if (value === undefined) throw new Error(`env option is missing its operand: -${flag}`);
            index = word.length;
          }
          apply(name, value);
          if (name === 'split-string') split = value;
        }
      }
      head += 1;
      if (split !== undefined) {
        // The command grant grammar forbids shell quoting and substitutions.
        // Retain the authorized literal split-string subset at execution too.
        if (/[^a-zA-Z0-9_./:=,+% @-]/.test(split)) {
          throw new Error('Cannot safely resolve env wrapper options: unsupported split string.');
        }
        argv.splice(head, 0, ...(split.trim() ? split.trim().split(/ +/) : []));
      }
    }
    // GNU env treats a bare dash after options as ignore-environment too.
    if (argv[head] === '-') { clear = true; head += 1; }
    if (clear) result = {};
    for (const name of unset) delete result[name];
    // Assignments are operands: subsequent dash-prefixed words are commands.
    while (head < argv.length && argv[head]!.includes('=')) {
      const assignment = argv[head++]!;
      const equal = assignment.indexOf('=');
      result[assignment.slice(0, equal)] = assignment.slice(equal + 1);
    }
    // Only the final -C applies, relative to this env invocation's incoming cwd.
    if (directory !== undefined) cwd = resolve(cwd, directory);
  }
  return { argv: argv.slice(head), cwd, env: result };
}

/** Resolve the first executable file exactly in the child execution PATH. */
function resolveGrantExecutable(path: string, cwd: string, env: NodeJS.ProcessEnv): string | undefined {
  if (path.includes('/')) return resolve(cwd, path);
  for (const directory of (env.PATH ?? '/usr/bin:/bin').split(':')) {
    const candidate = resolve(cwd, directory, path);
    try {
      accessSync(candidate, constants.X_OK);
      if (statSync(candidate).isFile()) return candidate;
    } catch { /* Continue as exec does for missing or inaccessible entries. */ }
  }
  return undefined;
}

/** Native executable headers; other direct files may use the ENOEXEC shell fallback. */
export function isNativeGrantExecutable(bytes: Buffer): boolean {
  if (bytes.length < 4) return false;
  const magic = bytes.readUInt32BE(0);
  return magic === 0x7f454c46 || // ELF
    magic === 0xfeedface || magic === 0xcefaedfe || // Mach-O
    magic === 0xfeedfacf || magic === 0xcffaedfe ||
    magic === 0xcafebabe || magic === 0xbebafeca || // Universal Mach-O
    magic === 0xcafebabf || magic === 0xbfbafeca ||
    (bytes[0] === 0x4d && bytes[1] === 0x5a); // Windows PE
}

/** Resolve the file using the parsed execution environment and directory. */
export function resolveGrantScriptExecutable(
  argument: { path: string; direct?: true },
  cwd: string,
  env: NodeJS.ProcessEnv,
): string | undefined {
  return argument.direct ? resolveGrantExecutable(argument.path, cwd, env) : resolve(cwd, argument.path);
}
