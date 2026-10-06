import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

/** The one setup command Beeline's own checkout defines. */
const CORNER_PREPARE_SCRIPT = 'corner:prepare';

/**
 * Whether this checkout defines its own `corner:prepare` npm script.
 *
 * `corner:prepare` is Beeline's own setup command; a corner on any other
 * repository has no reason to define it, and one told to run it fails on its
 * first command. A missing, unreadable, malformed, or non-string script
 * therefore means no, never an assumed yes.
 */
export async function hasCornerPrepareScript(worktreePath: string): Promise<boolean> {
  try {
    const parsed = JSON.parse(
      await readFile(resolve(worktreePath, 'package.json'), 'utf8'),
    ) as { scripts?: Record<string, unknown> };
    return typeof parsed.scripts?.[CORNER_PREPARE_SCRIPT] === 'string';
  } catch {
    return false;
  }
}
