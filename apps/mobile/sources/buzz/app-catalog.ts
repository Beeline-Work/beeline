/** Popular names are presentation hints; the server remains the app and route authority. */
export const POPULAR_APPS = [
  { name: 'Gmail', domain: 'gmail.com' },
  { name: 'Google Calendar', domain: 'calendar.google.com' },
  { name: 'Slack', domain: 'slack.com' },
  { name: 'Google Drive', domain: 'drive.google.com' },
  { name: 'Google Sheets', domain: 'sheets.google.com' },
  { name: 'Notion', domain: 'notion.so' },
  { name: 'Linear', domain: 'linear.app' },
  { name: 'HubSpot', domain: 'hubspot.com' },
  { name: 'Airtable', domain: 'airtable.com' },
  { name: 'Asana', domain: 'asana.com' },
  { name: 'Jira', domain: 'atlassian.com' },
  { name: 'Supabase', domain: 'supabase.com' },
] as const;

export function appDomain(name: string): string | undefined {
  return POPULAR_APPS.find((app) => app.name.toLowerCase() === name.toLowerCase())?.domain;
}
