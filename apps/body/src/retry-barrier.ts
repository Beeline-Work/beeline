import { DaemonApiError } from './daemon-api-client.js';

/** Also accepts the older server's dated diagnostic during a rolling update. */
export function retryNotBefore(error: unknown, now = Date.now()): number | undefined {
  if (error instanceof DaemonApiError && error.retryAfterMs !== undefined)
    return now + Math.max(0, error.retryAfterMs);
  const message = error instanceof Error ? error.message : String(error);
  const reset = message.match(/GitHub rate limit; checks readable again at (\d{4}-\d{2}-\d{2}T[\d:.]+Z)/i)?.[1];
  const time = reset ? Date.parse(reset) : NaN;
  return Number.isFinite(time) ? Math.max(now, time) : undefined;
}

/** These refusals require an adapter upgrade, sign-in, or configuration change. */
export function isStandingRuntimeFault(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error);
  return /\bACP error -(?:32600|32601|32602)\b|\bACP error -32000: Authentication required|command protocol|refusing intake/i.test(text);
}

/** Shared by every agent coordinator in this helper, including pushed starts. */
class CornerStartLimiter {
  private active = 0;
  private readonly pending: Array<() => void> = [];
  async acquire(): Promise<() => void> {
    if (this.active >= 4) await new Promise<void>(resolve => this.pending.push(resolve));
    else this.active++;
    await new Promise(resolve => setTimeout(resolve, 50 + Math.floor(Math.random() * 200)));
    return () => {
      const next = this.pending.shift();
      if (next) next();
      else this.active--;
    };
  }
}
export const cornerStarts = new CornerStartLimiter();
