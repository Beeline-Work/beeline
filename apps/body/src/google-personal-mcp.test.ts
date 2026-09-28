import { afterEach, expect, it, vi } from 'vitest';
import { callGooglePersonalTool } from './google-personal-mcp.js';

afterEach(() => vi.unstubAllGlobals());

it('uses the connected Google account to list Calendar events and Gmail messages', async () => {
  const fetcher = vi.fn(async (url: string) => new Response(JSON.stringify(
    url.includes('calendar') ? { items: [{ id: 'event-1', summary: 'Planning',
      start: { dateTime: '2030-01-01T10:00:00Z' } }] }
      : { messages: [{ id: 'message-1' }] }), { status: 200 }));
  vi.stubGlobal('fetch', fetcher);
  expect(JSON.parse(await callGooglePersonalTool('google_calendar_list_events', {}, 'token', '')))
    .toEqual([expect.objectContaining({ id: 'event-1', summary: 'Planning' })]);
  expect(JSON.parse(await callGooglePersonalTool('google_gmail_list_messages', { query: 'subject:hello' }, '', 'token')))
    .toEqual([{ id: 'message-1', snippet: undefined }]);
  expect(fetcher).toHaveBeenCalledTimes(2);
  await expect(callGooglePersonalTool('google_gmail_get_message', { id: 'message-1' }, '', ''))
    .rejects.toThrow('Gmail is disconnected');
});
