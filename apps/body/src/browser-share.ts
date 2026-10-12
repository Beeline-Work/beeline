import { WebSocket } from 'ws';
import { unknownServerEventLogger } from './unknown-server-event.js';

export type ChromiumPage = { id: string; type: string; title?: string; url?: string; webSocketDebuggerUrl?: string };
const COMPUTER_ACTIVITY_NAMES = [
  'viewer-opened', 'viewer-closed', 'takeover', 'input', 'navigation', 'handback',
] as const;
export type ComputerActivityEvent = {
  type: 'event'; seq: number; at: string;
  name: typeof COMPUTER_ACTIVITY_NAMES[number];
  detail?: string;
};

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
  const logUnknown = unknownServerEventLogger('computer-share');
  shares.get(input.page.id)?.cdp.close();
  shares.set(input.page.id, share);
  let serial = 1;
  const sendCdp = (method: string, params: Record<string, unknown> = {}) => {
    if (cdp.readyState !== WebSocket.OPEN) return undefined;
    const id = serial++;
    cdp.send(JSON.stringify({ id, method, params }));
    return id;
  };
  let lastFrameAt = 0;
  let firstFrameLogged = false;
  let inputCount = 0;
  let screenshotId: number | undefined;
  let screenshotStartedAt = 0;
  let fallbackTimer: NodeJS.Timeout | undefined;
  const capture = () => {
    if (screenshotId !== undefined && Date.now() - screenshotStartedAt < 5_000) return;
    screenshotId = sendCdp('Page.captureScreenshot', { format: 'jpeg', quality: 65, captureBeyondViewport: false });
    screenshotStartedAt = Date.now();
  };
  cdp.on('message', (data) => {
    let message: { id?: number; method?: string; params?: { sessionId?: number; frame?: { url?: string } }; result?: { data?: string }; error?: { message?: string } };
    try { message = JSON.parse(data.toString()) as typeof message; } catch { return; }
    if (message.id === screencastId)
      console.error(`[computer-share] screencast start ${message.error?.message ? `failed: ${message.error.message}` : 'accepted'}`);
    if (screenshotId !== undefined && message.id === screenshotId) {
      screenshotId = undefined;
      if (message.result?.data && relay.readyState === WebSocket.OPEN && relay.bufferedAmount < 4 * 1024 * 1024) {
        if (!firstFrameLogged) { firstFrameLogged = true; console.error('[computer-share] first JPEG forwarded from screenshot'); }
        relay.send(JSON.stringify({ method: 'Page.screencastFrame', params: { data: message.result.data, sessionId: 0 } }));
      } else if (message.error?.message) console.error(`[computer-share] screenshot failed: ${message.error.message}`);
      return;
    }
    if (message.method === 'Page.frameNavigated' && message.params?.frame?.url) {
      try {
        const url = new URL(message.params.frame.url);
        if (url.origin !== 'null' && relay.readyState === WebSocket.OPEN)
          relay.send(JSON.stringify({ type: 'share-event', name: 'navigation', detail: url.origin }));
      } catch { /* Internal browser URLs are not shared. */ }
      return;
    }
    if (message.method !== 'Page.screencastFrame') return;
    lastFrameAt = Date.now();
    if (!firstFrameLogged) { firstFrameLogged = true; console.error('[computer-share] first JPEG forwarded from screencast'); }
    // CDP frames are JSON text. `ws` passes incoming text as a Buffer, but
    // sending that Buffer makes the viewer receive a binary Blob instead.
    if (relay.readyState === WebSocket.OPEN && relay.bufferedAmount < 4 * 1024 * 1024)
      relay.send(data.toString());
    if (message.params?.sessionId !== undefined)
      sendCdp('Page.screencastFrameAck', { sessionId: message.params.sessionId });
  });
  relay.on('message', (data) => {
    let message: { type?: string; method?: string; params?: Record<string, unknown> };
    try { message = JSON.parse(data.toString()) as typeof message; } catch { return; }
    if (message.type === 'takeover') { share.controlled = true; console.error('[computer-share] viewer took control'); }
    else if (message.type === 'release') { share.controlled = false; console.error('[computer-share] viewer released control'); }
    else if (share.controlled && message.method?.startsWith('Input.')) {
      if (inputCount++ < 5) console.error(`[computer-share] forwarded ${message.method}`);
      sendCdp(message.method, message.params ?? {});
    }
    else if (message.type !== 'takeover' && message.type !== 'release') logUnknown(message.type);
  });
  const finish = () => {
    if (shares.get(input.page.id) !== share) return;
    shares.delete(input.page.id);
    clearTimeout(fallbackTimer);
    cdp.close(); relay.close();
    void input.onEnded();
  };
  cdp.once('close', finish);
  relay.once('close', finish);
  sendCdp('Page.enable');
  const screencastId = sendCdp('Page.startScreencast', { format: 'jpeg', quality: 65, maxWidth: 1280, maxHeight: 900, everyNthFrame: 1 });
  // A static or externally driven tab may never deliver a screencast frame.
  // Capture one immediately, then keep a slow fallback only while it is quiet.
  capture();
  const scheduleFallback = () => {
    fallbackTimer = setTimeout(() => {
      if (shares.get(input.page.id) !== share) return;
      if (Date.now() - lastFrameAt > 1_500) capture();
      scheduleFallback();
    }, 1_000);
    fallbackTimer.unref();
  };
  scheduleFallback();
}

/** One live event wait, with one authoritative reconcile if the socket reconnects. */
export async function waitForComputerHandback(input: {
  serverBaseUrl: string;
  shareId: string;
  daemonToken: string;
  expiresAt?: number;
  onEvent?: (event: ComputerActivityEvent) => void;
}): Promise<{ type: 'handoff' | 'ended'; note?: string; events: ComputerActivityEvent[] }> {
  const events: ComputerActivityEvent[] = [];
  const logUnknown = unknownServerEventLogger('computer-handback');
  let since = 0;
  for (let attempt = 0; attempt < 2; attempt++) {
    const url = new URL(`/s/${input.shareId}/wait?since=${since}`, input.serverBaseUrl);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    const result = await new Promise<{ type: 'handoff' | 'ended'; note?: string; events: ComputerActivityEvent[] } | undefined>((resolve, reject) => {
      const socket = new WebSocket(url, { headers: { authorization: `Bearer ${input.daemonToken}` } });
      let settled = false;
      const timer = input.expiresAt === undefined ? undefined : setTimeout(() => {
        settled = true;
        resolve({ type: 'ended', note: 'Squire live share expired', events });
        socket.close();
      }, Math.max(0, input.expiresAt - Date.now()));
      socket.on('message', (data) => {
        try {
          const value = JSON.parse(data.toString()) as {
            type?: string; note?: string; seq?: number; at?: string;
            name?: ComputerActivityEvent['name']; detail?: string;
          };
          if (!value || typeof value.type !== 'string' || !value.type) throw new Error('invalid handback event');
          if (value.type === 'event') {
            if (typeof value.seq === 'number' && Number.isSafeInteger(value.seq) && value.seq > since &&
                typeof value.at === 'string' && value.name) {
              since = value.seq;
              if (!COMPUTER_ACTIVITY_NAMES.includes(value.name)) {
                logUnknown(value.name);
                return;
              }
              const event: ComputerActivityEvent = { type: 'event', seq: value.seq, at: value.at,
                name: value.name, ...(value.detail ? { detail: value.detail } : {}) };
              events.push(event);
              input.onEvent?.(event);
            }
            return;
          }
          if (value.type !== 'handoff' && value.type !== 'ended') {
            logUnknown(value.type);
            return;
          }
          settled = true;
          if (timer) clearTimeout(timer);
          resolve({ type: value.type, ...(value.note ? { note: value.note } : {}), events });
          socket.close();
        } catch (error) { if (timer) clearTimeout(timer); reject(error); socket.close(); }
      });
      socket.once('close', () => { if (timer) clearTimeout(timer); if (!settled) resolve(undefined); });
      socket.once('error', () => { if (timer) clearTimeout(timer); if (!settled) resolve(undefined); });
    });
    if (result) return result;
  }
  throw new Error('Browser handback connection closed before a result');
}
