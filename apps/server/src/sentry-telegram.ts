import { createHash, timingSafeEqual } from 'node:crypto';
import { redactDiagnostic } from '@beeline/api-contract/error-reporting';

export interface SentryTelegramConfig { token: string; botToken: string; chatId: string; }

export function sentryTelegramFromEnv(env: NodeJS.ProcessEnv = process.env): SentryTelegramConfig | undefined {
  const token = env.BEELINE_SENTRY_WEBHOOK_TOKEN;
  const botToken = env.BEELINE_TELEGRAM_BOT_TOKEN;
  const chatId = env.BEELINE_TELEGRAM_CHAT_ID;
  return token && botToken && chatId ? { token, botToken, chatId } : undefined;
}

export function authenticSentryAlert(config: SentryTelegramConfig | undefined, token: string | null): boolean {
  if (!config || !token) return false;
  const hash = (value: string) => createHash('sha256').update(value).digest();
  return timingSafeEqual(hash(config.token), hash(token));
}

const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' ? value as Record<string, unknown> : {};

export function sentryTelegramMessage(payload: Record<string, unknown>): string | null {
  const data = object(payload.data);
  const issue = object(data.issue);
  const event = object(data.event ?? payload.event);
  const title = issue.title ?? event.title ?? event.message ?? payload.message;
  if (typeof title !== 'string' || !title.trim()) return null;
  const candidateLevel = String(event.level ?? issue.level ?? 'error').toLowerCase();
  const level = ['fatal', 'error', 'warning', 'info', 'debug'].includes(candidateLevel) ? candidateLevel : 'error';
  let link = 'https://beeline-bt.sentry.io/issues/';
  const candidate = payload.url ?? issue.web_url ?? issue.permalink ?? event.web_url;
  if (typeof candidate === 'string') {
    try {
      const url = new URL(candidate);
      if (url.protocol === 'https:' && !url.username && !url.password && !url.port &&
        (url.hostname === 'beeline-bt.sentry.io' ||
          (url.hostname === 'sentry.io' && url.pathname.startsWith('/organizations/beeline-bt/')))) {
        link = `${url.origin}${url.pathname}`;
      }
    } catch { /* Untrusted links never leave the configured Sentry organization. */ }
  }
  return `🔴 Beeline ${level}: ${redactDiagnostic(title).replace(/[\r\n\t]/g, ' ').slice(0, 1800)} ${link}`;
}

/** Outbound only. TestAtlas/Squire keep ownership of their bot's update webhook. */
export async function sendSentryTelegram(
  config: SentryTelegramConfig,
  message: string,
  send: typeof fetch = fetch,
): Promise<void> {
  try {
    const response = await send(`https://api.telegram.org/bot${config.botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: config.chatId, text: message, link_preview_options: { is_disabled: true } }),
      signal: AbortSignal.timeout(5000),
    });
    const result = await response.json() as { ok?: boolean; result?: { message_id?: number } };
    if (!response.ok || result.ok !== true) throw new Error('delivery refused');
    console.info('[sentry-relay] Telegram message sent', result.result?.message_id ?? '');
  } catch {
    // Fetch errors can include the request URL, which contains the bot token.
    throw new Error('Beeline Sentry Telegram delivery failed');
  }
}
