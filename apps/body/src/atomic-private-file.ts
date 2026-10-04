import { randomBytes } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';

/**
 * Replace `path` atomically with a 0600 file: write a sibling, fsync, rename.
 * A reader (another Room's linked copy, a running harness) sees the old file
 * or the new one, never half of either.
 */
export async function writePrivateFileAtomically(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.beeline-${process.pid}-${randomBytes(6).toString('base64url')}`;
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(contents, 'utf8');
    await handle.chmod(0o600);
    await handle.sync();
  } catch (error) {
    await handle.close();
    await rm(temporary, { force: true });
    throw error;
  }
  await handle.close();
  try {
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

/** The JSON object at `path`, or `{}` when it is missing or not an object. */
export async function readJsonObject(path: string): Promise<Record<string, unknown>> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}
