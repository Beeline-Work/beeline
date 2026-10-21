import { parseSigninFunnelEvent, FUNNEL_UUID } from '@beeline/api-contract/signin-funnel';
import type { SigninFunnelEvent } from '@beeline/api-contract/signin-funnel';

interface Store {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
}
type Context = Pick<
  SigninFunnelEvent,
  'installId' | 'attemptId' | 'platform' | 'version' | 'environment'
>;
const INSTALL_KEY = 'beeline.funnel.install.v1',
  ATTEMPT_KEY = 'beeline.funnel.attempt.v1';
/** One action, one best-effort send. No retry, interval, identity or free-text data. */
export function createSigninFunnelClient(input: {
  storage: Store;
  uuid(): string;
  platform: SigninFunnelEvent['platform'];
  version: string;
  environment: SigninFunnelEvent['environment'];
  send(event: SigninFunnelEvent, authorization?: string): Promise<void>;
  now?: () => number;
}) {
  const now = input.now ?? Date.now;
  let chain: Promise<unknown> = Promise.resolve(),
    suppressed = false;
  let session: Context | null = null,
    openedOnce = false;
  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const result = chain.then(work, work);
    chain = result.catch(() => undefined);
    return result;
  };
  const context = async () => {
    if (session) return session;
    let installId = await input.storage.getItem(INSTALL_KEY);
    if (!installId || !FUNNEL_UUID.test(installId)) {
      installId = input.uuid();
      await input.storage.setItem(INSTALL_KEY, installId);
    }
    session = {
      installId,
      attemptId: input.uuid(),
      platform: input.platform,
      version: input.version,
      environment: input.environment,
    };
    return session;
  };
  const send = (event: SigninFunnelEvent, authorization?: string) => {
    if (suppressed || input.environment !== 'production' || !parseSigninFunnelEvent(event, now()))
      return;
    void input.send(event, authorization).catch(() => undefined);
  };
  const readPending = async () => {
    try {
      const value = JSON.parse((await input.storage.getItem(ATTEMPT_KEY)) ?? 'null');
      if (
        !value ||
        !Number.isFinite(value.createdAt) ||
        now() - value.createdAt > 30 * 60_000 ||
        value.createdAt > now() + 300_000 ||
        !Array.isArray(value.sent)
      )
        return null;
      const event = parseSigninFunnelEvent(
        {
          ...value.context,
          event: 'provider_tapped',
          provider: value.provider,
          timestamp: new Date(now()).toISOString(),
        },
        now(),
      );
      if (!event) return null;
      const context: Context = {
        installId: event.installId,
        attemptId: event.attemptId,
        platform: event.platform,
        version: event.version,
        environment: event.environment,
      };
      return {
        context,
        provider: event.provider!,
        createdAt: value.createdAt as number,
        sent: value.sent.filter((v: unknown): v is string => typeof v === 'string').slice(0, 5),
      };
    } catch {
      return null;
    }
  };
  const step = async (
    event: SigninFunnelEvent['event'],
    provider?: 'github' | 'google',
    outcome?: SigninFunnelEvent['outcome'],
    errorCode?: SigninFunnelEvent['errorCode'],
    authorization?: string,
  ) => {
    if (suppressed || input.environment !== 'production') return undefined;
    const pending = await readPending();
    const base =
      provider || event === 'signed_in' || event === 'callback_result'
        ? pending?.context
        : await context();
    if (!base) return undefined;
    const actualProvider = provider ?? pending?.provider;
    const key = `${base.attemptId}:${event}`;
    if (pending?.context.attemptId === base.attemptId) {
      if (pending.sent.includes(key)) return pending.context;
      pending.sent.push(key);
      await input.storage.setItem(ATTEMPT_KEY, JSON.stringify(pending));
    } else {
      if (seen.has(key)) return base;
      seen.add(key);
    }
    send(
      {
        ...base,
        event,
        ...(actualProvider && ['provider_tapped', 'callback_result', 'signed_in'].includes(event)
          ? { provider: actualProvider }
          : {}),
        ...(outcome ? { outcome } : {}),
        ...(errorCode ? { errorCode } : {}),
        timestamp: new Date(now()).toISOString(),
      },
      authorization,
    );
    return base;
  };
  const seen = new Set<string>();
  return {
    opened: (signedIn: boolean, newOpen = false, authorization?: string) =>
      serial(async () => {
        if (openedOnce && !newOpen) return;
        openedOnce = true;
        const first = !(await input.storage.getItem(INSTALL_KEY));
        if (first || !signedIn) {
          session = null;
          await step('app_opened', undefined, undefined, undefined, authorization);
        }
      }),
    screen: () => serial(() => step('signin_screen_shown')),
    begin: (provider: 'github' | 'google') =>
      serial(async () => {
        if (suppressed || input.environment !== 'production') return undefined;
        const base = { ...(await context()), attemptId: input.uuid() };
        await input.storage.setItem(
          ATTEMPT_KEY,
          JSON.stringify({ context: base, provider, createdAt: now(), sent: [] }),
        );
        await step('provider_tapped', provider);
        return {
          ...base,
          event: 'provider_tapped' as const,
          provider,
          timestamp: new Date(now()).toISOString(),
        };
      }),
    callback: (outcome: SigninFunnelEvent['outcome'], errorCode?: SigninFunnelEvent['errorCode']) =>
      serial(() => step('callback_result', undefined, outcome, errorCode)),
    signedIn: (authorization: string) =>
      serial(() => step('signed_in', undefined, undefined, undefined, authorization)),
    pending: () =>
      serial(async () => {
        const value = await readPending();
        if (!value || suppressed) return undefined;
        return {
          ...value.context,
          event: 'provider_tapped' as const,
          provider: value.provider,
          timestamp: new Date(now()).toISOString(),
        } as SigninFunnelEvent;
      }),
    suppress: () => {
      suppressed = true;
    },
  };
}
