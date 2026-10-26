import { accessSync, constants, statSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

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

/** Apply the env wrapper context before inspecting a native candidate. */
function grantExecutionContext(argv: readonly string[], candidateIndex: number, env: NodeJS.ProcessEnv, cwd: string, nativeOptions = false): { env: NodeJS.ProcessEnv; cwd: string } {
  const result = { ...env };
  for (let index = 0; index < candidateIndex; index += 1) {
    if (argv[index]!.split('/').pop() !== 'env') continue;
    let directory: string | undefined;
    index += 1;
    if (argv[index] === '--') index += 1;
    while (index < candidateIndex) {
      const word = argv[index]!;
      if (nativeOptions && (word === '-i' || word === '--ignore-environment')) {
        for (const name of Object.keys(result)) delete result[name];
        index += 1;
        continue;
      }
      if (word === '--') { index += 1; continue; }
      if (nativeOptions && (['-u', '--unset', '-C', '--chdir', '-a', '--argv0'].includes(word) ||
          /^--(?:unset|chdir|argv0)=/.test(word) || /^-[uCa].+/.test(word))) {
        const separate = ['-u', '--unset', '-C', '--chdir', '-a', '--argv0'].includes(word);
        const value = separate ? argv[++index] : word.startsWith('--') ? word.slice(word.indexOf('=') + 1) : word.slice(2);
        if (value === undefined) throw new Error('env wrapper option is missing its operand');
        if (word.startsWith('-u') || word.startsWith('--unset')) delete result[value];
        if (word.startsWith('-C') || word.startsWith('--chdir')) directory = value;
        index += 1;
        continue;
      }
      if (word.startsWith('-')) {
        throw new Error('Cannot safely resolve env wrapper options. Use env NAME=value command or request approval for the script directly.');
      }
      const assignment = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s.exec(word);
      if (!assignment) break;
      result[assignment[1]!] = assignment[2]!;
      index += 1;
    }
    // env applies only its final chdir option, relative to the incoming cwd.
    if (directory !== undefined) cwd = resolve(cwd, directory);
    index -= 1;
  }
  return { env: result, cwd };
}

/** Detect native files with the wrapper environment before applying script refusals. */
export function resolveGrantScriptExecutable(
  argv: readonly string[],
  argument: { index: number; path: string; direct?: true },
  cwd: string,
  env: NodeJS.ProcessEnv,
  read: (path: string) => Buffer = readFileSync,
): string | undefined {
  if (argument.direct) {
    try {
      const nativeEnv = grantExecutionContext(argv, argument.index, env, cwd, true);
      const candidate = resolveGrantExecutable(argument.path, nativeEnv.cwd, nativeEnv.env);
      if (candidate && isNativeGrantExecutable(read(candidate))) return candidate;
    } catch { /* Script resolution below retains the refusal for unsupported options. */ }
  }
  const scriptEnv = grantExecutionContext(argv, argument.index, env, cwd);
  return argument.direct ? resolveGrantExecutable(argument.path, scriptEnv.cwd, scriptEnv.env) : resolve(scriptEnv.cwd, argument.path);
}
