import { WebSocket } from 'ws';

export type ChromiumPage = { id: string; type: string; title?: string; url?: string; webSocketDebuggerUrl?: string };

/** Choose an existing page; this never launches a browser or a fresh tab. */
export async function findChromiumPage(debugUrl: string, target?: string): Promise<ChromiumPage> {
  const origin = new URL(debugUrl);
  if (!['http:', 'https:'].includes(origin.protocol)) throw new Error('Chromium debug URL is invalid');
  const response = await fetch(new URL('/json/list', origin), { signal: AbortSignal.timeout(5_000) });
  if (!response.ok) throw new Error('Chromium debugging endpoint is unavailable');
  const pages = (await response.json()) as ChromiumPage[];
  const page = pages.find((item) => item.type === 'page' &&
    (!target || item.id === target || item.url?.includes(target) || item.title?.includes(target)));
  if (!page?.webSocketDebuggerUrl) throw new Error('No matching open Chromium tab');
  return page;
}

type Share = { cdp: WebSocket; relay: WebSocket; controlled: boolean };
const shares = new Map<string, Share>();

/** Agent browser tools can await this before an action on a shared tab. */
export function browserIsHumanControlled(pageId: string): boolean {
  return shares.get(pageId)?.controlled ?? false;
}

function opened(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
}

/** Relay CDP screencast and input over an outbound authenticated socket. */
export async function shareChromiumPage(input: {
  page: ChromiumPage;
  serverBaseUrl: string;
  shareId: string;
  daemonToken: string;
  onEnded: () => Promise<void>;
}): Promise<void> {
  if (!input.page.webSocketDebuggerUrl) throw new Error('Chromium page has no debugger socket');
  const cdp = new WebSocket(input.page.webSocketDebuggerUrl);
  await opened(cdp);
  const source = new URL(`/s/${input.shareId}/source`, input.serverBaseUrl);
  source.protocol = source.protocol === 'https:' ? 'wss:' : 'ws:';
  const relay = new WebSocket(source, { headers: { authorization: `Bearer ${input.daemonToken}` } });
  try { await opened(relay); } catch (error) { cdp.close(); throw error; }
  const share: Share = { cdp, relay, controlled: false };
  shares.get(input.page.id)?.cdp.close();
  shares.set(input.page.id, share);
  let serial = 1;
  const sendCdp = (method: string, params: Record<string, unknown> = {}) => {
    if (cdp.readyState === WebSocket.OPEN) cdp.send(JSON.stringify({ id: serial++, method, params }));
  };
  cdp.on('message', (data) => {
    let message: { method?: string; params?: { sessionId?: number } };
    try { message = JSON.parse(data.toString()) as typeof message; } catch { return; }
    if (message.method !== 'Page.screencastFrame') return;
    if (relay.readyState === WebSocket.OPEN && relay.bufferedAmount < 4 * 1024 * 1024) relay.send(data);
    if (message.params?.sessionId !== undefined)
      sendCdp('Page.screencastFrameAck', { sessionId: message.params.sessionId });
  });
  relay.on('message', (data) => {
    let message: { type?: string; method?: string; params?: Record<string, unknown> };
    try { message = JSON.parse(data.toString()) as typeof message; } catch { return; }
    if (message.type === 'takeover') share.controlled = true;
    else if (message.type === 'release') share.controlled = false;
    else if (share.controlled && message.method?.startsWith('Input.'))
      sendCdp(message.method, message.params ?? {});
  });
  const finish = () => {
    if (shares.get(input.page.id) !== share) return;
    shares.delete(input.page.id);
    cdp.close(); relay.close();
    void input.onEnded();
  };
  cdp.once('close', finish);
  relay.once('close', finish);
  sendCdp('Page.enable');
  sendCdp('Page.startScreencast', { format: 'jpeg', quality: 65, maxWidth: 1280, maxHeight: 900, everyNthFrame: 1 });
}

/** One live event wait, with one authoritative reconcile if the socket reconnects. */
export async function waitForComputerHandback(input: {
  serverBaseUrl: string;
  shareId: string;
  daemonToken: string;
}): Promise<{ type: 'handoff' | 'ended'; note?: string }> {
  const url = new URL(`/s/${input.shareId}/wait?since=0`, input.serverBaseUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await new Promise<{ type: 'handoff' | 'ended'; note?: string } | undefined>((resolve, reject) => {
      const socket = new WebSocket(url, { headers: { authorization: `Bearer ${input.daemonToken}` } });
      let settled = false;
      socket.once('message', (data) => {
        try {
          const value = JSON.parse(data.toString()) as { type?: string; note?: string };
          if (value.type !== 'handoff' && value.type !== 'ended') throw new Error('invalid handback event');
          settled = true;
          resolve({ type: value.type, ...(value.note ? { note: value.note } : {}) });
          socket.close();
        } catch (error) { reject(error); socket.close(); }
      });
      socket.once('close', () => { if (!settled) resolve(undefined); });
      socket.once('error', () => { if (!settled) resolve(undefined); });
    });
    if (result) return result;
  }
  throw new Error('Browser handback connection closed before a result');
}
