import { typedMentionHandles } from './message-mentions.js';
import { readFile } from 'node:fs/promises';

export interface BanterAgent { id: string; name: string; handle: string; instructions: string }
export interface BanterLine { agentId: string; text: string }
export type BanterCompletion = (agent: BanterAgent, messages: { role: 'system' | 'user'; content: string }[], signal: AbortSignal) => Promise<string>;

export function validBanterLine(text: string, name: string, speaker: BanterAgent, tagged?: BanterAgent): boolean {
  const words = text.trim().split(/\s+/u);
  const tokens: string[] = text.toLocaleLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [];
  const includesName = (value: string) => new RegExp(`(?<![\\p{L}\\p{N}_])${value.replace(/^@/, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}_])`, 'iu').test(text);
  const mentions = [...typedMentionHandles(text)].map(handle => handle.toLocaleLowerCase());
  return !!text.trim() && words.length < 25 && includesName(name)
    && !tokens.some(word => ['he', 'she', 'him', 'her', 'his', 'hers', 'kill', 'prey', 'victim', 'idiot', 'stupid', 'dumb', 'blade', 'assassin', 'assassins', 'murder'].includes(word))
    && !includesName(speaker.name) && !includesName(speaker.handle)
    && (!tagged || mentions.includes(tagged.handle.replace(/^@/, '').toLocaleLowerCase()));
}

/** Every call uses the speaking agent's stored instructions and the accepted exchange so far. */
export async function generateStarterBanter(input: {
  name: string; time: string; beebee: BanterAgent; luna: BanterAgent;
  complete: BanterCompletion; signal: AbortSignal; brief?: string;
}): Promise<BanterLine[] | null> {
  const brief = (input.brief ?? await readFile(new URL('../assets/banter-brief.md', import.meta.url), 'utf8'))
    .replaceAll('{name}', input.name).replaceAll('{time}', input.time)
    .replaceAll('@luna', `@${input.luna.handle.replace(/^@/, '')}`)
    .replaceAll('@beebee', `@${input.beebee.handle.replace(/^@/, '')}`);
  const lines: BanterLine[] = [];
  for (const [index, agent] of [input.beebee, input.luna, input.beebee].entries()) {
    const tagged = index === 0 ? input.luna : index === 1 ? input.beebee : undefined;
    let accepted = false;
    for (let attempt = 0; attempt < 2; attempt++) {
      input.signal.throwIfAborted();
      const exchange = lines.map(line => `${line.agentId === input.beebee.id ? input.beebee.name : input.luna.name}: ${line.text}`).join('\n');
      const text = (await input.complete(agent, [
        { role: 'system', content: agent.instructions },
        { role: 'user', content: `${brief}\n\nExchange so far:\n${exchange || '(none)'}\nWrite line ${index + 1}.${attempt ? ' The previous attempt failed the checks. Follow every rule, including the first name and required handle.' : ''}` },
      ], input.signal)).trim();
      if (!validBanterLine(text, input.name, agent, tagged)) continue;
      lines.push({ agentId: agent.id, text });
      accepted = true;
      break;
    }
    if (!accepted) return null;
  }
  return lines;
}

/** Time starts on Room entry; late generations cannot delay or follow the hello. */
export async function starterBanterBeforeDeadline(generation: Promise<BanterLine[] | null>, openedAt: number,
  signal: AbortController, now = Date.now): Promise<BanterLine[] | null> {
  if (now() >= openedAt + 20_000) { signal.abort(); return null; }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([generation.catch(() => null), new Promise<null>(resolve => {
      timer = setTimeout(() => { signal.abort(); resolve(null); }, Math.max(0, openedAt + 20_000 - now()));
    })]);
  } finally { if (timer) clearTimeout(timer); }
}
