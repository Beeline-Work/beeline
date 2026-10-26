import { accessSync, constants, statSync } from 'node:fs';
import { resolve } from 'node:path';

/** Resolve the first executable file exactly in the child execution PATH. */
export function resolveGrantExecutable(path: string, cwd: string, env: NodeJS.ProcessEnv): string | undefined {
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
