import { mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** One model-facing MCP result. Save the original before replacing its body. */
export async function boundToolResult<T>(result: T, root = process.env.BEELINE_ATTACH_SCRATCH_ROOT ?? homedir()): Promise<T | {
  content: { type: string; text?: string; [key: string]: unknown }[]; isError?: boolean; _meta: { originalOutputBytes: number };
}> {
  // Images and audio have their own model accounting. Preserve them rather
  // than turning a screenshot into an unreadable fragment of base64.
  const media = result && typeof result === 'object' && 'content' in result && Array.isArray(result.content)
    ? result.content.filter(block => block && (block.type === 'image' || block.type === 'audio')) : [];
  const textResult = media.length && result && typeof result === 'object' && 'content' in result
    ? { ...result, content: (result.content as unknown[]).filter(block => !media.includes(block)) } : result;
  const serialized = JSON.stringify(result);
  const original = Buffer.from(serialized);
  const textBytes = Buffer.from(JSON.stringify(textResult));
  if (textBytes.byteLength <= 32_768) return result;
  const directory = join(root, 'tool-output');
  const path = join(directory, `${randomUUID()}.json`);
  let recovery: string;
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(path, original, { mode: 0o600, flag: 'wx' });
    recovery = `Full result saved at ${JSON.stringify(path)}. Read it in bounded byte ranges with native file tools or shell (dd if=PATH bs=1 skip=OFFSET count=4096).`;
  } catch {
    recovery = 'The full result could not be saved. Repeat the call using provider pagination, a narrower query, or a smaller shell output range.';
  }
  const text = `[Tool result capped: original ${original.byteLength} UTF-8 bytes.] ${recovery}\nHEAD:\n${textBytes.subarray(0, 6_144).toString('utf8')}\n[... omitted ...]\nTAIL:\n${textBytes.subarray(-6_144).toString('utf8')}`;
  return { content: [{ type: 'text', text }, ...media], _meta: { originalOutputBytes: original.byteLength },
    ...(result && typeof result === 'object' && 'isError' in result && result.isError === true ? { isError: true } : {}) };
}

/** Correlated transport responses only; never rewrite protocol or schema messages. */
export async function boundToolResponse(message: Record<string, unknown>): Promise<string> {
  if (message.result && typeof message.result === 'object' && 'content' in message.result) {
    return JSON.stringify({ ...message, result: await boundToolResult(message.result) });
  }
  return JSON.stringify(message);
}
