/**
 * Google Workspace client — the typed seam every Google tool connector
 * (gmail / calendar / drive / youtube) speaks through.
 *
 * MCP strategy decision (Workbench Google tools, 2026-09): WRAP, don't adopt.
 * The well-documented open-source Google Workspace MCP servers (e.g.
 * `@gongrzhe/server-gmail-autoauth-mcp`, `google-workspace-mcp`) assume a
 * local OAuth token file and mount one all-scope server; they bypass the
 * Workbench usage ledger, the Squire vault's masked-credential boundary, and
 * the scope minimization the connector model exists for. Beeline already
 * wraps every external capability behind a typed client interface
 * (`SquireMcpClient`) and records usage per turn (`ConnectorUsageRecorder`),
 * so the same shape is applied here: a typed `GoogleWorkspaceClient` over
 * Google's REST APIs with a pluggable `GoogleTokenSource` (Squire vault via
 * the typed seam in `connector-google.ts`, or manually pasted credentials).
 * Exposing these capabilities to agent sessions later reuses the existing
 * `McpServerWire` session-mount pattern (`room-session.ts`) — the same path
 * the Squire broker takes — rather than a raw stdio server the harness owns.
 *
 * Tests never touch Google: they drive a fake transport.
 */

/** One OAuth grant for one person's Google account, held by a token source. */
export type GoogleCredentials = {
  readonly accessToken: string;
  readonly refreshToken?: string;
  /** Expiry in epoch ms; the source decides how staleness is handled. */
  readonly expiresAt?: number;
  readonly accountEmail?: string;
};

/** Where an access token comes from (vault, manual paste, refresh, …). */
export type GoogleTokenSource = {
  /** A usable bearer token, refreshing if the source can. */
  readonly accessToken: () => Promise<string>;
  readonly accountEmail?: () => string | undefined;
};

export function credentialsTokenSource(credentials: GoogleCredentials): GoogleTokenSource {
  return {
    accessToken: () => Promise.resolve(credentials.accessToken),
    accountEmail: credentials.accountEmail ? () => credentials.accountEmail : undefined,
  };
}

/** The one HTTP seam; the default implementation is fetch against Google. */
export type GoogleApiTransport = {
  readonly request: (
    method: string,
    url: string,
    body?: unknown,
    headers?: Record<string, string>,
  ) => Promise<{ status: number; json: unknown }>;
};

export const defaultGoogleApiTransport: GoogleApiTransport = {
  async request(method, url, body, headers) {
    const response = await fetch(url, {
      method,
      headers: {
        'content-type': 'application/json',
        ...headers,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    let json: unknown = null;
    const text = await response.text();
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        json = { raw: text };
      }
    }
    return { status: response.status, json };
  },
};

export class GoogleApiError extends Error {
  constructor(
    readonly status: number,
    readonly detail: string,
  ) {
    super(`Google API ${status}: ${detail}`);
  }
}

/** Bounded page size so one capability method stays one request. */
const MAX_RESULTS = 25;

function assertOk(status: number, json: unknown): void {
  if (status >= 200 && status < 300) return;
  const detail =
    json && typeof json === 'object' && 'error' in json
      ? JSON.stringify((json as { error: unknown }).error)
      : `HTTP ${status}`;
  throw new GoogleApiError(status, detail);
}

/** Gmail: draft/send/read messages. */
export type GmailCapability = {
  listMessages(query?: string): Promise<{ id: string; snippet?: string }[]>;
  getMessage(id: string): Promise<{ id: string; snippet?: string; body?: string }>;
  createDraft(input: { to: string; subject: string; body: string }): Promise<{ id: string }>;
  sendMessage(input: { to: string; subject: string; body: string }): Promise<{ id: string }>;
};

/** Google Calendar: schedule/fetch events. */
export type CalendarCapability = {
  listEvents(input?: { maxResults?: number }): Promise<
    { id: string; summary?: string; start?: string; end?: string }[]
  >;
  createEvent(input: {
    calendarId?: string;
    summary: string;
    start: string;
    end: string;
    description?: string;
  }): Promise<{ id: string; htmlLink?: string }>;
};

/** Google Drive: search/read documents. */
export type DriveCapability = {
  searchFiles(query: string): Promise<{ id: string; name?: string; mimeType?: string }[]>;
  readFile(fileId: string): Promise<{ id: string; name?: string; content: string }>;
};

/** YouTube: access transcripts/playlists. */
export type YouTubeCapability = {
  listPlaylists(mine?: boolean): Promise<{ id: string; title?: string }[]>;
  listPlaylistItems(playlistId: string): Promise<{ videoId: string; title?: string }[]>;
  getTranscript(videoId: string): Promise<{ videoId: string; transcript: string }>;
};

export type GoogleWorkspaceClient = {
  readonly gmail: GmailCapability;
  readonly calendar: CalendarCapability;
  readonly drive: DriveCapability;
  readonly youtube: YouTubeCapability;
  /** One authorized probe — the connect checklist's "Google authorized" step. */
  readonly verify: () => Promise<{ ok: true; account?: string } | { ok: false; reason: string }>;
};

function rfc822(input: { to: string; subject: string; body: string }): string {
  return `To: ${input.to}\r\nSubject: ${input.subject}\r\nContent-Type: text/plain; charset="UTF-8"\r\n\r\n${input.body}`;
}

/** The real client over Google REST APIs. One instance per connection. */
export function googleWorkspaceClient(
  tokenSource: GoogleTokenSource,
  transport: GoogleApiTransport = defaultGoogleApiTransport,
): GoogleWorkspaceClient {
  // Every request carries the bearer from the token source; a stale token
  // fails as GoogleApiError(401) — the token source is responsible for
  // refresh, and a refused one tells the human to reconnect the tool.
  const authorized: GoogleApiTransport = {
    async request(method, url, body) {
      const token = await tokenSource.accessToken();
      const response = await transport.request(method, url, body, {
        authorization: `Bearer ${token}`,
      });
      if (response.status === 401) {
        throw new GoogleApiError(401, 'access token rejected; reconnect the Google tool');
      }
      return response;
    },
  };

  const gmailFetch = async (path: string) => {
    const { status, json } = await authorized.request(
      'GET',
      `https://gmail.googleapis.com/gmail/v1/users/me${path}`,
    );
    assertOk(status, json);
    return json as Record<string, unknown>;
  };

  return {
    gmail: {
      async listMessages(query) {
        const params = new URLSearchParams({ maxResults: String(MAX_RESULTS) });
        if (query) params.set('q', query);
        const { status, json } = await authorized.request(
          'GET',
          `https://gmail.googleapis.com/gmail/v1/users/me/messages?${params}`,
        );
        assertOk(status, json);
        const messages = (json as { messages?: { id: string; snippet?: string }[] }).messages ?? [];
        return messages.map((entry) => ({ id: entry.id, snippet: entry.snippet }));
      },
      async getMessage(id) {
        const message = await gmailFetch(`/messages/${encodeURIComponent(id)}?format=metadata`);
        const snippet = typeof message.snippet === 'string' ? message.snippet : undefined;
        const payload = message.payload as
          | { headers?: { name: string; value: string }[]; body?: { data?: string } }
          | undefined;
        const subject = payload?.headers?.find((header) => header.name === 'Subject')?.value;
        const bodyText =
          payload?.body?.data !== undefined
            ? Buffer.from(payload.body.data, 'base64url').toString('utf8')
            : undefined;
        return { id, snippet: subject ?? snippet, body: bodyText };
      },
      async createDraft(input) {
        const { status, json } = await authorized.request(
          'POST',
          'https://gmail.googleapis.com/gmail/v1/users/me/drafts',
          { message: { raw: Buffer.from(rfc822(input), 'utf8').toString('base64url') } },
        );
        assertOk(status, json);
        return { id: String((json as { id: string }).id) };
      },
      async sendMessage(input) {
        const raw = Buffer.from(rfc822(input), 'utf8').toString('base64url');
        const { status, json } = await authorized.request(
          'POST',
          'https://gmail.googleapis.com/gmail/v1/users/me/messages/send',
          { raw },
        );
        assertOk(status, json);
        return { id: String((json as { id: string }).id) };
      },
    },
    calendar: {
      async listEvents(input) {
        const params = new URLSearchParams({
          maxResults: String(input?.maxResults ?? MAX_RESULTS),
          singleEvents: 'true',
          orderBy: 'startTime',
          timeMin: new Date().toISOString(),
        });
        const { status, json } = await authorized.request(
          'GET',
          `https://www.googleapis.com/calendar/v3/calendars/primary/events?${params}`,
        );
        assertOk(status, json);
        const events = (json as { items?: Record<string, unknown>[] }).items ?? [];
        return events.map((event) => ({
          id: String(event.id),
          summary: typeof event.summary === 'string' ? event.summary : undefined,
          start: (event.start as { dateTime?: string } | undefined)?.dateTime,
          end: (event.end as { dateTime?: string } | undefined)?.dateTime,
        }));
      },
      async createEvent(input) {
        const { status, json } = await authorized.request(
          'POST',
          `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(input.calendarId ?? 'primary')}/events`,
          {
            summary: input.summary,
            ...(input.description ? { description: input.description } : {}),
            start: { dateTime: input.start },
            end: { dateTime: input.end },
          },
        );
        assertOk(status, json);
        const event = json as { id: string; htmlLink?: string };
        return { id: event.id, ...(event.htmlLink ? { htmlLink: event.htmlLink } : {}) };
      },
    },
    drive: {
      async searchFiles(query) {
        const params = new URLSearchParams({
          q: `name contains '${query.replace(/'/g, "\\'")}' and trashed = false`,
          pageSize: String(MAX_RESULTS),
          fields: 'files(id,name,mimeType)',
        });
        const { status, json } = await authorized.request(
          'GET',
          `https://www.googleapis.com/drive/v3/files?${params}`,
        );
        assertOk(status, json);
        return ((json as { files?: Record<string, unknown>[] }).files ?? []).map((file) => ({
          id: String(file.id),
          name: typeof file.name === 'string' ? file.name : undefined,
          mimeType: typeof file.mimeType === 'string' ? file.mimeType : undefined,
        }));
      },
      async readFile(fileId) {
        const meta = await authorized.request(
          'GET',
          `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?fields=id,name`,
        );
        assertOk(meta.status, meta.json);
        const content = await authorized.request(
          'GET',
          `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`,
        );
        assertOk(content.status, content.json);
        const body = content.json as { raw?: string };
        return {
          id: fileId,
          name: (meta.json as { name?: string }).name,
          content: body.raw ?? JSON.stringify(content.json),
        };
      },
    },
    youtube: {
      async listPlaylists(mine = true) {
        const params = new URLSearchParams({
          part: 'snippet',
          maxResults: String(MAX_RESULTS),
          ...(mine ? { mine: 'true' } : {}),
        });
        const { status, json } = await authorized.request(
          'GET',
          `https://www.googleapis.com/youtube/v3/playlists?${params}`,
        );
        assertOk(status, json);
        return ((json as { items?: Record<string, unknown>[] }).items ?? []).map((item) => ({
          id: String(item.id),
          title: (item.snippet as { title?: string } | undefined)?.title,
        }));
      },
      async listPlaylistItems(playlistId) {
        const params = new URLSearchParams({
          part: 'snippet',
          maxResults: String(MAX_RESULTS),
          playlistId,
        });
        const { status, json } = await authorized.request(
          'GET',
          `https://www.googleapis.com/youtube/v3/playlistItems?${params}`,
        );
        assertOk(status, json);
        return ((json as { items?: Record<string, unknown>[] }).items ?? []).map((item) => ({
          videoId: String((item.snippet as { resourceId?: { videoId?: string } })?.resourceId?.videoId ?? item.id),
          title: (item.snippet as { title?: string } | undefined)?.title,
        }));
      },
      async getTranscript(videoId) {
        // YouTube's timedtext captions need a signed video player response;
        // a plain REST transcript endpoint does not exist, so this is
        // intentionally a typed best-effort that reports why it failed.
        const params = new URLSearchParams({ lang: 'en', v: videoId });
        const { status, json } = await authorized.request(
          'GET',
          `https://video.google.com/timedtext?${params}`,
        );
        if (status < 200 || status >= 300) {
          throw new GoogleApiError(
            status,
            `no caption track could be fetched for ${videoId} (timedtext ${status})`,
          );
        }
        const raw = (json as { raw?: string }).raw ?? '';
        const transcript = raw.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        if (!transcript) {
          throw new GoogleApiError(404, `video ${videoId} has no fetchable captions`);
        }
        return { videoId, transcript };
      },
    },
    async verify() {
      try {
        const { status, json } = await authorized.request(
          'GET',
          'https://www.googleapis.com/oauth2/v3/userinfo',
        );
        if (status === 401) return { ok: false as const, reason: 'Google rejected the access token' };
        assertOk(status, json);
        const email = (json as { email?: string }).email;
        return { ok: true as const, ...(email ? { account: email } : {}) };
      } catch (error) {
        return {
          ok: false as const,
          reason: error instanceof Error ? error.message : String(error),
        };
      }
    },
  };
}
