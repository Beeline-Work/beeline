import { createHash } from 'node:crypto';

export const hash = (value) => createHash('sha256').update(`transcript-speed-v1:${value}`).digest('hex');
export const uuid = (value) => {
  const h = hash(value);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
};
export const viewer = createHash('sha256').update('beeline:play-review-identity').digest('hex');
export const workspace = uuid('workspace');
export const rooms = [uuid('room-a'), uuid('room-b')];
export const corner = uuid('streaming-corner');
export const agents = [hash('agent-a'), hash('agent-b')];

/** Reject remote targets and connection parameters that could redirect libpq. */
export function localDatabase(value) {
  const url = new URL(value);
  if (!['postgres:', 'postgresql:'].includes(url.protocol) ||
      !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
      !/^\/beeline_latency_rig_transcript_[a-z0-9_]+$/.test(url.pathname) ||
      [...url.searchParams].some(([key, value]) => key !== 'host' || value !== '/var/run/postgresql'))
    throw new Error('Requires a loopback beeline_latency_rig_transcript_* database; connection overrides refused');
  return value;
}

export function messages(room, imageOrigin) {
  const url = new URL(imageOrigin);
  if (!['127.0.0.1', 'localhost', '10.0.2.2'].includes(url.hostname))
    throw new Error('Fixture images must use the local fixture server');
  return Array.from({ length: 1000 }, (_, n) => {
    const kind = n % 8;
    const label = `Fixture ${String(n).padStart(4, '0')}`;
    const text = kind === 1 ? `## ${label}\n\n${'A long paragraph with **bold**, *emphasis*, and a [local link](http://localhost).\n\n'.repeat(12)}`
      : kind === 2 ? `${label}\n\n\`\`\`typescript\n${'const square = (n: number) => n * n;\n'.repeat(18)}\`\`\``
      : kind === 7 ? `${label}: agent answer\n\n${'Measured results need repeatable inputs. '.repeat(30)}`
      : `${label}: a repeatable conversation message.`;
    return { id: hash(`${room}:${n}`), text, author: kind === 7 ? agents[Math.floor(n / 8) % 2] : viewer,
      createdAt: new Date(Date.UTC(2026, 9, 1) + n * 1000).toISOString(),
      attachments: kind === 3 ? [{ url: `${url.origin}/image.png?row=${n}`, name: 'delayed.png', mimeType: 'image/png', size: 68, width: 320, height: 180 }] : [],
      reactions: kind === 4 ? { '👍': [viewer, agents[0]], '✨': [agents[1]] } : {},
      reply: kind === 5 ? hash(`${room}:${n - 1}`) : null,
      kind,
    };
  });
}
