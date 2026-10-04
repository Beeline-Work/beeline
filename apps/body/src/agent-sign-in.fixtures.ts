/**
 * Headless login output as the real CLIs printed it on 2026-10-04 (ANSI
 * colour removed). Codes and challenges are from abandoned attempts.
 */

/** `codex login --device-auth`, Codex 0.160.0. */
export const CODEX_DEVICE_OUTPUT = `
Welcome to Codex [v0.160.0]
OpenAI's command-line coding agent

Follow these steps to sign in with ChatGPT using device code authorization:

1. Open this link in your browser and sign in to your account
   https://auth.openai.com/codex/device

2. Enter this one-time code (expires in 15 minutes)
   EBQ9-VJCLN

Continue only if you started this login in Codex. If a website or another person gave you this code, cancel.
`;

/** `grok login --device-auth`, Grok 1.0.46. */
export const GROK_DEVICE_OUTPUT = `
To sign in, open this URL in your browser:

  https://accounts.x.ai/oauth2/device?user_code=2RDF-2C74

  (Could not open browser automatically — open the URL above manually.)

Confirm this code in your browser:

  2RDF-2C74

Only continue with a code you requested. Don't share it with anyone.

Waiting for authorization...
`;

/** `NO_OPEN_BROWSER=1 cursor-agent login`, Cursor Agent 2026.10.01-e373342. */
export const CURSOR_LOGIN_OUTPUT = `Starting login process...
Authenticating with Cursor...
Waiting for browser authentication...
Open a browser and navigate to this link: https://cursor.com/loginDeepControl?challenge=INZtIO70adwqYFOZA047ajbYLE7XW3K6ceG4IkULyLE&uuid=f2174507-b113-463b-a584-e3ffb20853d9&mode=login&redirectTarget=cli&supportsSelectedTeamLogin=true
`;
