import { spawn } from 'node:child_process';

export interface CursorModelCatalog {
  currentValue: string;
  options: Array<{ id: string; name?: string }>;
}

/** Bounded wait for the CLI; a slow or missing binary must not hang connect. */
const CURSOR_MODELS_TIMEOUT_MS = 10_000;

/**
 * Parse `cursor-agent models` output. Each model prints as one line:
 *
 *   auto - Auto (current, default)
 *   gpt-5.3-codex - GPT-5.3
 *
 * `auto` is cursor-agent's own default and is always served, so it anchors
 * the picker's initial value whenever the CLI lists it.
 */
export function parseCursorModelsOutput(output: string): CursorModelCatalog | undefined {
  const options: Array<{ id: string; name?: string }> = [];
  for (const line of output.split(/\r?\n/)) {
    const match = /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)\s+-\s+(\S.*?)\s*$/.exec(line);
    if (!match) continue;
    const id = match[1] as string;
    const name = (match[2] as string).replace(/\s*\(current, default\)\s*$/i, '').trim();
    options.push({ id, ...(name && name !== id ? { name } : {}) });
  }
  if (!options.length) return undefined;
  return {
    currentValue: options.some((option) => option.id === 'auto') ? 'auto' : (options[0] as { id: string }).id,
    options,
  };
}

/**
 * Enumerate the models cursor-agent actually serves by running its own
 * `models` command. The owned cursor ACP bridge advertises this catalog at
 * `session/new`; this CLI read remains the connect fallback when ACP is empty.
 */
export async function enumerateCursorModels(
  env: NodeJS.ProcessEnv = process.env,
): Promise<CursorModelCatalog | undefined> {
  return new Promise((resolve) => {
    const child = spawn('cursor-agent', ['models'], {
      env,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    let output = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
    }, CURSOR_MODELS_TIMEOUT_MS);
    child.stdout?.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.on('error', () => {
      clearTimeout(timer);
      resolve(undefined);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve(code === 0 ? parseCursorModelsOutput(output) : undefined);
    });
  });
}
