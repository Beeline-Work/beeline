import type { NostrEvent } from '@beeline/nostr';

export function filterRelayEvents(
  events: readonly NostrEvent[],
  filters: Array<Record<string, unknown>>,
): NostrEvent[] {
  return events.filter((event) =>
    filters.some((filter) =>
      Object.entries(filter).every(([key, values]) => {
        if (key === 'kinds' && Array.isArray(values)) return values.includes(event.kind);
        if (key === 'authors' && Array.isArray(values)) return values.includes(event.pubkey);
        if (key === 'since' && typeof values === 'number') return event.created_at >= values;
        if (key === 'until' && typeof values === 'number') return event.created_at <= values;
        if (!key.startsWith('#') || !Array.isArray(values)) return true;
        return event.tags.some(
          (tag) => tag[0] === key.slice(1) && (values as string[]).includes(tag[1]!),
        );
      }),
    ),
  );
}

/** Minimal relay `/query` projection for Body tests that record signed publishes. */
export function relayQueryResponse(
  events: readonly NostrEvent[],
  input: string | URL | Request,
  init?: RequestInit,
): Response | undefined {
  if (!String(input).endsWith('/query')) return undefined;
  const filters = JSON.parse(String(init?.body)) as Array<Record<string, unknown>>;
  const matches = filterRelayEvents(events, filters);
  return new Response(JSON.stringify(matches), { status: 200 });
}
