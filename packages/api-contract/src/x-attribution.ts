/** First-party web click context; deliberately independent of the anonymous funnel. */
export interface XAttribution {
  twclid?: string;
  campaignId?: string;
  adId?: string;
  adGroupId?: string;
  capturedAt: number;
}

export const X_ATTRIBUTION_COOKIE = 'beeline_x_click';
export const X_ATTRIBUTION_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;
export const X_PIXEL_ID = 'rhefr';

export function parseXAttribution(value: unknown, now = Date.now()): XAttribution | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const v = value as Record<string, unknown>;
  if (
    Object.keys(v).some(
      (k) => !['twclid', 'campaignId', 'adId', 'adGroupId', 'capturedAt'].includes(k),
    )
  )
    return;
  if (
    typeof v.capturedAt !== 'number' ||
    !Number.isSafeInteger(v.capturedAt) ||
    v.capturedAt > now + 60_000 ||
    v.capturedAt < now - X_ATTRIBUTION_LIFETIME_MS
  )
    return;
  for (const key of ['twclid', 'campaignId', 'adId', 'adGroupId']) {
    if (
      v[key] !== undefined &&
      (typeof v[key] !== 'string' || !/^[A-Za-z0-9_.~-]{1,256}$/.test(v[key] as string))
    )
      return;
  }
  return {
    capturedAt: v.capturedAt,
    ...Object.fromEntries(
      ['twclid', 'campaignId', 'adId', 'adGroupId']
        .filter((k) => v[k] !== undefined)
        .map((k) => [k, v[k]]),
    ),
  };
}

export function readWebXAttribution(): XAttribution | undefined {
  if (
    typeof document === 'undefined' ||
    typeof location === 'undefined' ||
    !['usebeeline.app', 'web.usebeeline.app', 'localhost'].includes(location.hostname)
  )
    return;
  try {
    const params = new URL(location.href).searchParams;
    if (params.has('twclid') || params.get('utm_source')?.toLowerCase() === 'x') {
      const context = parseXAttribution({
        capturedAt: Date.now(),
        ...(params.get('twclid') ? { twclid: params.get('twclid') } : {}),
        ...(params.get('utm_campaign') ? { campaignId: params.get('utm_campaign') } : {}),
        ...(params.get('utm_content') ? { adId: params.get('utm_content') } : {}),
        ...(params.get('utm_term') ? { adGroupId: params.get('utm_term') } : {}),
      });
      if (context) {
        const domain = location.hostname === 'localhost' ? '' : '; Domain=usebeeline.app; Secure';
        document.cookie = `${X_ATTRIBUTION_COOKIE}=${encodeURIComponent(JSON.stringify(context))}; Path=/; Max-Age=${X_ATTRIBUTION_LIFETIME_MS / 1000}; SameSite=Lax${domain}`;
        return context;
      }
    }
    const raw = document.cookie.split('; ').find((c) => c.startsWith(`${X_ATTRIBUTION_COOKIE}=`));
    return raw
      ? parseXAttribution(
          JSON.parse(decodeURIComponent(raw.slice(X_ATTRIBUTION_COOKIE.length + 1))),
        )
      : undefined;
  } catch {
    return;
  }
}

type XQueue = ((...args: unknown[]) => void) & {
  queue?: unknown[][];
  version?: string;
  exe?: (...args: unknown[]) => void;
};
/** No X requests on ordinary visits. The queue also handles an ad blocker safely. */
export function loadXPixel(context = readWebXAttribution()): XQueue | undefined {
  if (!context || typeof window === 'undefined' || typeof document === 'undefined') return;
  // Never let the vendor inspect an OAuth callback URL or its credentials.
  if (
    typeof location !== 'undefined' &&
    (/[?&#](?:code|state|ticket|token|access_token|id_token|secret|oidcToken)=/i.test(
      location.href,
    ) ||
      /\/(?:auth|callback|review)(?:\/|$)/i.test(location.pathname))
  )
    return;
  const browser = window as unknown as { twq?: XQueue };
  if (!browser.twq) {
    const queue: XQueue = (...args) => {
      if (queue.exe) queue.exe(...args);
      else queue.queue!.push(args);
    };
    queue.queue = [];
    queue.version = '1.1';
    browser.twq = queue;
    const script = document.createElement('script');
    script.async = true;
    script.src = 'https://static.ads-twitter.com/uwt.js';
    document.head.appendChild(script);
    queue('config', X_PIXEL_ID);
  }
  return browser.twq;
}

export function trackXSignup(event: { eventId: string; conversionId: string } | undefined): void {
  if (
    !event ||
    !/^tw-[a-z0-9]+-[a-z0-9]+$/.test(event.eventId) ||
    !/^[a-f0-9]{64}$/.test(event.conversionId)
  )
    return;
  loadXPixel()?.('event', event.eventId, { conversion_id: event.conversionId });
}
