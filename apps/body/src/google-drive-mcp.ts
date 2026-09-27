import { credentialsTokenSource, googleWorkspaceClient } from './google-workspace-client.js';

export const GOOGLE_DRIVE_MCP_SURFACE = 'google-drive';
export const GOOGLE_DRIVE_MCP_SERVER_NAME = 'google-drive';
export const GOOGLE_DRIVE_MCP_TOOLS = [{
  name: 'google_drive_list_files',
  description: 'List up to 25 non-trashed files in the connected Google Drive.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
}] as const;

export async function callGoogleDriveTool(name: string, token: string): Promise<string> {
  if (name !== 'google_drive_list_files') throw new Error(`unknown Google Drive tool: ${name}`);
  if (!token) throw new Error('Google Workspace is disconnected; reconnect it in Workbench');
  const files = await googleWorkspaceClient(credentialsTokenSource({ accessToken: token })).drive.listFiles();
  return JSON.stringify(files);
}
