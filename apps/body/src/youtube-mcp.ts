#!/usr/bin/env node
/**
 * Beeline-owned YouTube MCP. We vendor the Data API + Analytics query
 * surface locked from pauling-ai/youtube-mcp-server (MIT, audited 2026-09)
 * and run it ourselves on this helper.
 *
 * Why not spawn the community process as-is:
 *   - pauling-ai/youtube-mcp-server is Python/FastMCP and opens its own
 *     browser OAuth (`youtube_auth` / InstalledAppFlow). That would be a
 *     second Google overlay; Workbench already has the in-app sign-in.
 *   - kirbah/mcp-youtube is API-key only (no OAuth, no Analytics API) and
 *     advertises a Smithery host — handing our grant there is refused.
 *
 * The access token is injected as `BEELINE_YOUTUBE_ACCESS_TOKEN` by the
 * session mount. It never leaves this process. Analytics tools restate
 * `YOUTUBE_ANALYTICS_OWNER_LIMIT`: Google answers only the channel owner.
 */
import { createInterface } from 'node:readline';
import { readFileSync } from 'node:fs';
import {
  GoogleApiError,
  YOUTUBE_ANALYTICS_OWNER_LIMIT,
  credentialsTokenSource,
  defaultAnalyticsDateRange,
  googleWorkspaceClient,
  type GoogleWorkspaceClient,
  type YouTubeAnalyticsQuery,
} from './google-workspace-client.js';

export { YOUTUBE_ANALYTICS_OWNER_LIMIT };

export const YOUTUBE_MCP_SERVER_NAME = 'youtube';
export const YOUTUBE_MCP_SURFACE = 'youtube';

export const YOUTUBE_VENDOR_LOCK = {
  source: 'pauling-ai/youtube-mcp-server',
  license: 'MIT',
  audited: '2026-09-18',
  rejected: 'kirbah/mcp-youtube (API key only; no owner Analytics; Smithery host)',
} as const;

type JsonObject = Record<string, unknown>;

type YoutubeMcpTool = {
  name: string;
  description: string;
  inputSchema: JsonObject;
};

const dateProps = {
  startDate: { type: 'string', description: 'YYYY-MM-DD. Defaults to 28 days ago.' },
  endDate: { type: 'string', description: 'YYYY-MM-DD. Defaults to today (UTC).' },
};

const analyticsOwnerNote = ` ${YOUTUBE_ANALYTICS_OWNER_LIMIT}`;

export const YOUTUBE_MCP_TOOLS: readonly YoutubeMcpTool[] = [
  {
    name: 'youtube_get_channel',
    description: 'Get the signed-in channel (id, title, handle, subscribers).',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'youtube_list_videos',
    description: 'List videos on the signed-in channel.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'youtube_get_video',
    description: 'Get one video’s title, description, and view count.',
    inputSchema: {
      type: 'object',
      required: ['videoId'],
      properties: { videoId: { type: 'string', minLength: 1 } },
      additionalProperties: false,
    },
  },
  {
    name: 'youtube_list_playlists',
    description: 'List playlists on the signed-in channel.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'youtube_list_playlist_items',
    description: 'List videos in one playlist.',
    inputSchema: {
      type: 'object',
      required: ['playlistId'],
      properties: { playlistId: { type: 'string', minLength: 1 } },
      additionalProperties: false,
    },
  },
  {
    name: 'youtube_get_transcript',
    description: 'Fetch captions for a video when a public timedtext track exists.',
    inputSchema: {
      type: 'object',
      required: ['videoId'],
      properties: { videoId: { type: 'string', minLength: 1 } },
      additionalProperties: false,
    },
  },
  {
    name: 'youtube_analytics_overview',
    description: `Channel views, watch time, subscribers, likes for a date range.${analyticsOwnerNote}`,
    inputSchema: { type: 'object', properties: dateProps, additionalProperties: false },
  },
  {
    name: 'youtube_analytics_top_videos',
    description: `Top long-form videos by views (excludes Shorts).${analyticsOwnerNote}`,
    inputSchema: {
      type: 'object',
      properties: {
        ...dateProps,
        maxResults: { type: 'integer', minimum: 1, maximum: 25 },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'youtube_analytics_traffic_sources',
    description: `How viewers found the channel (search, suggested, browse…).${analyticsOwnerNote}`,
    inputSchema: { type: 'object', properties: dateProps, additionalProperties: false },
  },
  {
    name: 'youtube_analytics_demographics',
    description: `Audience age-group and gender breakdown.${analyticsOwnerNote}`,
    inputSchema: { type: 'object', properties: dateProps, additionalProperties: false },
  },
];

function stringArg(args: JsonObject, key: string): string | undefined {
  const value = args[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function dateArgs(args: JsonObject): Pick<YouTubeAnalyticsQuery, 'startDate' | 'endDate'> {
  const startDate = stringArg(args, 'startDate');
  const endDate = stringArg(args, 'endDate');
  if (startDate && endDate) return { startDate, endDate };
  return defaultAnalyticsDateRange();
}

export function youtubeClientFromToken(accessToken: string): GoogleWorkspaceClient {
  return googleWorkspaceClient(credentialsTokenSource({ accessToken }));
}

export async function callYoutubeTool(
  name: string,
  args: JsonObject,
  client: GoogleWorkspaceClient,
): Promise<string> {
  try {
    return JSON.stringify(await invokeYoutubeTool(name, args, client));
  } catch (error) {
    if (error instanceof GoogleApiError && error.status === 403 && name.startsWith('youtube_analytics_')) {
      throw new Error(YOUTUBE_ANALYTICS_OWNER_LIMIT);
    }
    throw error;
  }
}

async function invokeYoutubeTool(
  name: string,
  args: JsonObject,
  client: GoogleWorkspaceClient,
): Promise<unknown> {
  switch (name) {
    case 'youtube_get_channel':
      return client.youtube.getChannel(true);
    case 'youtube_list_videos':
      return client.youtube.listVideos();
    case 'youtube_get_video': {
      const videoId = stringArg(args, 'videoId');
      if (!videoId) throw new Error('videoId is required');
      return client.youtube.getVideo(videoId);
    }
    case 'youtube_list_playlists':
      return client.youtube.listPlaylists(true);
    case 'youtube_list_playlist_items': {
      const playlistId = stringArg(args, 'playlistId');
      if (!playlistId) throw new Error('playlistId is required');
      return client.youtube.listPlaylistItems(playlistId);
    }
    case 'youtube_get_transcript': {
      const videoId = stringArg(args, 'videoId');
      if (!videoId) throw new Error('videoId is required');
      return client.youtube.getTranscript(videoId);
    }
    case 'youtube_analytics_overview':
      return client.youtube.analyticsQuery({
        metrics:
          'views,estimatedMinutesWatched,averageViewDuration,subscribersGained,subscribersLost,likes,comments,shares',
        ...dateArgs(args),
      });
    case 'youtube_analytics_top_videos':
      return client.youtube.analyticsQuery({
        metrics: 'views,estimatedMinutesWatched,averageViewDuration,likes,comments,shares',
        dimensions: 'video',
        filters: 'creatorContentType==video_on_demand',
        sort: '-views',
        maxResults: typeof args.maxResults === 'number' ? args.maxResults : 20,
        ...dateArgs(args),
      });
    case 'youtube_analytics_traffic_sources':
      return client.youtube.analyticsQuery({
        metrics: 'views,estimatedMinutesWatched',
        dimensions: 'insightTrafficSourceType',
        sort: '-views',
        ...dateArgs(args),
      });
    case 'youtube_analytics_demographics':
      return client.youtube.analyticsQuery({
        metrics: 'viewerPercentage',
        dimensions: 'ageGroup,gender',
        sort: '-viewerPercentage',
        ...dateArgs(args),
      });
    default:
      throw new Error(`unknown YouTube tool: ${name}`);
  }
}

function youtubeAccessToken(env: NodeJS.ProcessEnv = process.env): string {
  let token = env.BEELINE_YOUTUBE_ACCESS_TOKEN?.trim();
  const path = env.BEELINE_GOOGLE_CREDENTIALS_PATH;
  if (path) {
    try {
      const stored = JSON.parse(readFileSync(path, 'utf8')) as { accessToken?: string };
      token = stored.accessToken?.trim();
    } catch {
      token = undefined;
    }
  }
  if (!token) {
    throw new Error(
      'YouTube is not signed in on this helper. Connect Google Workspace from the Workbench — the same in-app sign-in, not a second overlay.',
    );
  }
  return token;
}

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: unknown;
}

function asObject(value: unknown): JsonObject {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonObject)
    : {};
}

function send(message: JsonObject): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function success(id: JsonRpcRequest['id'], result: unknown): void {
  send({ jsonrpc: '2.0', id: id ?? null, result });
}

function failure(id: JsonRpcRequest['id'], code: number, message: string): void {
  send({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
}

async function handleYoutubeMcpLine(
  line: string,
  clientFactory: () => GoogleWorkspaceClient = () => youtubeClientFromToken(youtubeAccessToken()),
): Promise<void> {
  let request: JsonRpcRequest;
  try {
    request = JSON.parse(line) as JsonRpcRequest;
  } catch {
    failure(null, -32700, 'invalid JSON');
    return;
  }
  if (request.id === undefined) return;
  try {
    if (request.method === 'initialize') {
      const params = asObject(request.params);
      success(request.id, {
        protocolVersion:
          typeof params.protocolVersion === 'string' ? params.protocolVersion : '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: YOUTUBE_MCP_SERVER_NAME, version: '1.0.0' },
      });
      return;
    }
    if (request.method === 'ping') {
      success(request.id, {});
      return;
    }
    if (request.method === 'tools/list') {
      success(request.id, { tools: YOUTUBE_MCP_TOOLS });
      return;
    }
    if (request.method === 'tools/call') {
      const params = asObject(request.params);
      if (typeof params.name !== 'string') throw new Error('tool name must be a string');
      try {
        const output = await callYoutubeTool(params.name, asObject(params.arguments), clientFactory());
        success(request.id, { content: [{ type: 'text', text: output }] });
      } catch (error) {
        success(request.id, {
          content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }],
          isError: true,
        });
      }
      return;
    }
    failure(request.id, -32601, `method not found: ${request.method ?? ''}`);
  } catch (error) {
    failure(request.id, -32602, error instanceof Error ? error.message : String(error));
  }
}

/** Stdio entry used when this file is the process main (`beeline-youtube-mcp`). */
function listenYoutubeMcpStdio(): void {
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  lines.on('line', (line) => void handleYoutubeMcpLine(line));
}

if (/(?:^|\/)youtube-mcp\.(?:js|mjs|ts)$/.test(process.argv[1] ?? '')) {
  listenYoutubeMcpStdio();
}
