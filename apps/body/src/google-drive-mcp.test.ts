import { afterEach, describe, expect, it, vi } from 'vitest';
import { GOOGLE_DRIVE_MCP_TOOLS, callGoogleDriveTool } from './google-drive-mcp.js';

afterEach(() => vi.unstubAllGlobals());

describe('Google Drive MCP', () => {
  it('lists files with the connected Room token', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ files: [
      { id: 'file-1', name: 'Roadmap' },
    ] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    expect(GOOGLE_DRIVE_MCP_TOOLS.map((tool) => tool.name)).toEqual(['google_drive_list_files']);
    expect(JSON.parse(await callGoogleDriveTool('google_drive_list_files', 'room-token'))).toEqual([
      { id: 'file-1', name: 'Roadmap' },
    ]);
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('/drive/v3/files?'),
      expect.objectContaining({ headers: expect.objectContaining({ authorization: 'Bearer room-token' }) }));
  });

  it('refuses absent credentials and unknown tools', async () => {
    await expect(callGoogleDriveTool('google_drive_list_files', '')).rejects.toThrow('disconnected');
    await expect(callGoogleDriveTool('google_drive_delete_file', 'token')).rejects.toThrow('unknown');
  });
});
