# Google Workspace OAuth verification draft

The Cloud OAuth consent screen is in **In production**. Its branding is verified; data access is not yet verified. Keep the Cloud client ID and secret aligned with the Composio auth config without copying either secret into this document. On 2026-09-28, the unused `gmail.send`, `gmail.compose`, and `calendar.events` declarations were removed from the production project's Data Access page; Google confirmed the changes were saved. The retained declarations were Calendar read, Gmail read, Drive read, YouTube read, and YouTube Analytics read. YouTube upload (`youtube.upload`) is now also requested and must be declared on the Data Access page before submission.

## How Google sign-in runs

The first-party Google OAuth route and its `https://server.usebeeline.app/v1/google/oauth/callback` callback were retired in #1874. Google sign-in now runs through Composio. Beeline's production Google client is registered in the Composio dashboard as a custom (non-managed) OAuth2 auth config, and the server links through that config.

YouTube connects only through that custom config. The server never falls back to Composio's shared Google app for YouTube, because that app is in Google testing mode and blocks sign-in. Until the custom YouTube config exists and is enabled, Workbench app search leaves YouTube out and `connect_app` reports that YouTube is not available to connect yet. Other Google toolkits prefer the custom config when one exists and otherwise use Composio's managed app.

**Redirect URI:** with a custom auth config, Google redirects to Composio's callback, not to a Beeline domain. Google review may require the redirect on a domain we own. If so, set up Composio's white-label redirect on a Beeline domain and register that URI on the Cloud client before submission.

## Requested scopes and purpose

Each tool is connected separately through its own Composio toolkit, which requests the scopes set on that toolkit's auth config.

| Selected tool | Scope | User-facing reason and demo action |
| --- | --- | --- |
| Calendar | `https://www.googleapis.com/auth/calendar.readonly` | Read the person's upcoming primary-calendar events to answer a Room or DM request. Show an agent listing events after the person approves the card. |
| Gmail | `https://www.googleapis.com/auth/gmail.readonly` | Read messages that the person asks an agent to find or summarize. Show a message search and a selected message. |
| Drive | `https://www.googleapis.com/auth/drive.readonly` | List non-trashed files the person asks about. Show a file listing after consent. |
| YouTube | `https://www.googleapis.com/auth/youtube.readonly`, `https://www.googleapis.com/auth/yt-analytics.readonly`, and `https://www.googleapis.com/auth/youtube.upload` | Read the connected channel's videos and owner Analytics, and upload a video the person asks an agent to publish. Show channel, video, and Analytics queries and an upload from the owner account. |

## Verification submission copy

**App purpose:** Beeline lets an agent's human owner connect selected Google Workspace tools so that agent can answer the owner's explicit requests in a Beeline Room or direct message. The owner starts Google consent from Workbench or an in-conversation Connect card. The grant is held by Composio for that owner, using Beeline's Google client. Google tokens are never posted into chat. The owner can disconnect from Workbench.

**Why these scopes:** Calendar read access supplies upcoming events; Gmail read access supplies search and message reading; Drive read access supplies file listings; YouTube read and Analytics access supply channel content and owner metrics; YouTube upload publishes a video the owner asked for. Each tool is offered separately.

**User control:** The owner must tap Connect and complete Google's consent. A denied, cancelled, failed, or expired attempt returns to Connect. The conversation continues only after a successful consent for the selected tool and resumes the original request. Workbench provides Disconnect for the account. A different Room member cannot accept a Google card for that agent's owner-bound grant.

## Demo video script

1. Start with Google tools disconnected in Workbench.
2. In a Room, ask an agent to read upcoming Calendar events. Show the Calendar Connect card and tap once. Show Google's account chooser and scope list, and complete consent.
3. Return to the same Room. Show the accepted card, the agent resuming the original Calendar request, and the event answer. Repeat the card flow in a DM.
4. Show a cancelled attempt returning to a clean Connect action. Retry successfully.
5. In Workbench, connect Gmail, Drive, and YouTube separately and show each consent scope list and matching tool result, including a YouTube upload. Show Disconnect.

Record the video against the production OAuth client registered in Composio, and the redirect URI that will be submitted. Review Google's live verification form against this copy and attach the video and any required domain/privacy/security evidence before submission. The data-access verification is **not submitted**; Google review, and any required restricted-scope assessment, remain external gates.
