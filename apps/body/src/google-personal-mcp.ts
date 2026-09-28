import { credentialsTokenSource, googleWorkspaceClient } from './google-workspace-client.js';

export const GOOGLE_PERSONAL_MCP_SURFACE = 'google-personal';
export const GOOGLE_PERSONAL_MCP_SERVER_NAME = 'google-personal';
export const GOOGLE_PERSONAL_MCP_TOOLS = [
  { name: 'google_calendar_list_events', description: 'List upcoming events from the connected Google Calendar.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'google_gmail_list_messages', description: 'List messages in the connected Gmail account. An optional Gmail search query narrows results.',
    inputSchema: { type: 'object', properties: { query: { type: 'string' } }, additionalProperties: false } },
  { name: 'google_gmail_get_message', description: 'Read one Gmail message by id.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false } },
] as const;

export async function callGooglePersonalTool(name: string, args: Record<string, unknown>,
  calendarToken: string, gmailToken: string): Promise<string> {
  if (name === 'google_calendar_list_events') {
    if (!calendarToken) throw new Error('Google Calendar is disconnected; connect it in Workbench');
    return JSON.stringify(await googleWorkspaceClient(credentialsTokenSource({ accessToken: calendarToken }))
      .calendar.listEvents());
  }
  if (name === 'google_gmail_list_messages' || name === 'google_gmail_get_message') {
    if (!gmailToken) throw new Error('Gmail is disconnected; connect it in Workbench');
    const client = googleWorkspaceClient(credentialsTokenSource({ accessToken: gmailToken }));
    if (name === 'google_gmail_list_messages') {
      if (args.query !== undefined && typeof args.query !== 'string') throw new Error('query must be a string');
      return JSON.stringify(await client.gmail.listMessages(args.query as string | undefined));
    }
    if (typeof args.id !== 'string' || !args.id) throw new Error('id is required');
    return JSON.stringify(await client.gmail.getMessage(args.id));
  }
  throw new Error(`unknown Google tool: ${name}`);
}
