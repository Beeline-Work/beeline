import { afterEach, describe, expect, it, vi } from 'vitest';
import { GOOGLE_TOOL_SCOPES } from '@beeline/api-contract/workbench';
import { callGoogleDriveTool } from './google-drive-mcp.js';
import { roomGoogleToolFingerprint, roomGoogleToolTokens } from './room-google-grant.js';
import { googleDriveMcpServer, googlePersonalMcpServer } from './room-session.js';

afterEach(() => vi.unstubAllGlobals());

describe('Room Google tools after Workbench connection', () => {
  it('mounts Drive on the next turn after the parent Gmail connection, then renews an expired access token', async () => {
    let state: 'pending' | 'ready' = 'pending';
    let token = 'first-token';
    const api = { execute: async (name: string, input: { roomId: string }) => {
      expect(name).toBe('getRoomGoogleGrant');
      expect(input.roomId).toBe('room-1');
      return state === 'pending' ? { status: 'pending' } : {
        status: 'ready', connectedTypes: ['google-gmail'],
        credentials: { accessToken: token, expiresAt: Date.now() + 3_600_000,
          scopes: GOOGLE_TOOL_SCOPES['google-drive'] },
      };
    } };
    const config = { readonlyMcpCommand: '/bin/beeline-mcp' } as never;
    const before = await roomGoogleToolTokens(api as never, 'room-1');
    expect(before).toEqual({});
    expect(googleDriveMcpServer(config, before.drive)).toBeUndefined();

    state = 'ready';
    const connected = await roomGoogleToolTokens(api as never, 'room-1');
    expect(googleDriveMcpServer(config, connected.drive)).toMatchObject({ name: 'google-drive' });
    expect(connected.drive).toBe('first-token');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ files: [
      { id: 'file-1', name: 'Connected file' },
    ] }), { status: 200 })));
    expect(JSON.parse(await callGoogleDriveTool('google_drive_list_files', connected.drive!))).toEqual([
      { id: 'file-1', name: 'Connected file' },
    ]);

    token = 'renewed-token';
    const renewed = await roomGoogleToolTokens(api as never, 'room-1');
    expect(renewed.drive).toBe('renewed-token');
    expect(roomGoogleToolFingerprint(renewed)).not.toEqual(roomGoogleToolFingerprint(connected));
  });

  it('mounts Gmail with its scopes while Drive still needs its own scope', async () => {
    const api = { execute: async () => ({ status: 'ready', connectedTypes: ['google-gmail'],
      credentials: { accessToken: 'token', scopes: GOOGLE_TOOL_SCOPES['google-gmail'] } }) };
    const tokens = await roomGoogleToolTokens(api as never, 'room-1');
    expect(tokens).toEqual({ gmail: 'token' });
    expect(googlePersonalMcpServer({ readonlyMcpCommand: '/bin/beeline-mcp' } as never,
      tokens)).toMatchObject({ name: 'google-personal' });
  });

  it('keeps a legacy Gmail token alongside a direct Calendar connection', async () => {
    const api = { execute: async () => ({ status: 'ready',
      connectedTypes: ['google-calendar', 'google-gmail'],
      credentials: { accessToken: 'calendar-token', scopes: GOOGLE_TOOL_SCOPES['google-calendar'] },
      credentialsByType: {
        'google-calendar': { accessToken: 'calendar-token', scopes: GOOGLE_TOOL_SCOPES['google-calendar'] },
        'google-gmail': { accessToken: 'gmail-token', scopes: GOOGLE_TOOL_SCOPES['google-gmail'] },
      },
    }) };
    expect(await roomGoogleToolTokens(api as never, 'room-1')).toEqual({
      calendar: 'calendar-token', gmail: 'gmail-token',
    });
  });

  it('drops a YouTube mount on the next turn after that product is unpaired', async () => {
    let connectedTypes = ['google-youtube'];
    const api = { execute: async () => ({ status: 'ready', connectedTypes,
      credentials: { accessToken: 'token', scopes: GOOGLE_TOOL_SCOPES['google-youtube'] } }) };
    expect(await roomGoogleToolTokens(api as never, 'room-1')).toEqual({ youtube: 'token' });
    connectedTypes = [];
    expect(await roomGoogleToolTokens(api as never, 'room-1')).toEqual({});
  });
});
