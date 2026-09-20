import { describe, expect, it } from 'vitest';
import {
  YOUTUBE_ANALYTICS_OWNER_LIMIT,
  YOUTUBE_MCP_SERVER_NAME,
  YOUTUBE_MCP_TOOLS,
  YOUTUBE_VENDOR_LOCK,
  callYoutubeTool,
} from './youtube-mcp.js';
import { GoogleApiError, type GoogleWorkspaceClient } from './google-workspace-client.js';

function fakeYoutube(overrides: Partial<GoogleWorkspaceClient['youtube']> = {}): GoogleWorkspaceClient {
  return {
    youtube: {
      getChannel: async () => ({ id: 'UC1', title: 'Bee', handle: '@bee' }),
      listVideos: async () => [{ videoId: 'v1', title: 'Hello' }],
      getVideo: async (videoId) => ({ id: videoId, title: 'Hello', viewCount: '9' }),
      listPlaylists: async () => [{ id: 'PL1', title: 'Favorites' }],
      listPlaylistItems: async () => [{ videoId: 'v1', title: 'Hello' }],
      getTranscript: async (videoId) => ({ videoId, transcript: 'hi there' }),
      analyticsQuery: async (input) => ({
        startDate: input.startDate ?? '2026-08-21',
        endDate: input.endDate ?? '2026-09-18',
        columns: input.metrics.split(','),
        results: [{ views: 12 }],
        totalRows: 1,
      }),
      ...overrides,
    },
  } as GoogleWorkspaceClient;
}

describe('youtube MCP vendor lock', () => {
  it('names the audited in-tree wrapper and refuses the hosted API-key server', () => {
    expect(YOUTUBE_VENDOR_LOCK.source).toBe('pauling-ai/youtube-mcp-server');
    expect(YOUTUBE_VENDOR_LOCK.rejected).toMatch(/kirbah/);
    expect(YOUTUBE_VENDOR_LOCK.rejected).toMatch(/Smithery/);
    expect(YOUTUBE_MCP_SERVER_NAME).toBe('youtube');
  });

  it('documents the owner-account Analytics limit on every analytics tool', () => {
    const analytics = YOUTUBE_MCP_TOOLS.filter((tool) => tool.name.startsWith('youtube_analytics_'));
    expect(analytics.length).toBeGreaterThan(0);
    for (const tool of analytics) {
      expect(tool.description).toContain(YOUTUBE_ANALYTICS_OWNER_LIMIT);
    }
  });
});

describe('callYoutubeTool', () => {
  it('returns channel and playlist Data API reads as JSON', async () => {
    const client = fakeYoutube();
    expect(JSON.parse(await callYoutubeTool('youtube_get_channel', {}, client))).toEqual({
      id: 'UC1',
      title: 'Bee',
      handle: '@bee',
    });
    expect(JSON.parse(await callYoutubeTool('youtube_list_playlists', {}, client))).toEqual([
      { id: 'PL1', title: 'Favorites' },
    ]);
  });

  it('locks Analytics overview onto channel==MINE metrics from the vendored query', async () => {
    let seen: { metrics?: string } | undefined;
    const client = fakeYoutube({
      analyticsQuery: async (input) => {
        seen = input;
        return {
          startDate: '2026-08-21',
          endDate: '2026-09-18',
          columns: ['views'],
          results: [{ views: 4 }],
          totalRows: 1,
        };
      },
    });
    await callYoutubeTool('youtube_analytics_overview', {}, client);
    expect(seen?.metrics).toContain('views');
    expect(seen?.metrics).toContain('estimatedMinutesWatched');
  });

  it('restates the owner-account limit when Analytics returns 403', async () => {
    const client = fakeYoutube({
      analyticsQuery: async () => {
        throw new GoogleApiError(403, 'forbidden');
      },
    });
    await expect(callYoutubeTool('youtube_analytics_overview', {}, client)).rejects.toThrow(
      YOUTUBE_ANALYTICS_OWNER_LIMIT,
    );
  });
});
