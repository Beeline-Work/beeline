# Google OAuth verification draft (YouTube)

The Cloud OAuth consent screen is in **In production**. Its branding is verified; data access is not yet verified. Keep the Cloud client ID and secret aligned with the Composio auth config without copying either secret into this document.

The verification submission covers YouTube scopes only. On 2026-09-28, the unused `gmail.send`, `gmail.compose`, and `calendar.events` declarations were removed from the production project's Data Access page. On 2026-10-04, `calendar.readonly`, `gmail.readonly`, and `drive.readonly` were also removed and saved; after reload the page lists only `yt-analytics.readonly` (non-sensitive), `youtube.upload` and `youtube.readonly` (sensitive), and no restricted scopes. Calendar, Gmail, and Drive connect through Composio's managed configs, not Beeline's Google client, so they are not part of this submission.

## How Google sign-in runs

The first-party Google OAuth route and its `https://server.usebeeline.app/v1/google/oauth/callback` callback were retired in #1874. Google sign-in now runs through Composio. Beeline's production Google client is registered in the Composio dashboard as a custom (non-managed) OAuth2 auth config, and the server links through that config.

YouTube connects only through that custom config. The server never falls back to Composio's shared Google app for YouTube, because that app is in Google testing mode and blocks sign-in. Until the custom YouTube config exists and is enabled, Workbench app search leaves YouTube out and `connect_app` reports that YouTube is not available to connect yet. Other Google toolkits prefer the custom config when one exists and otherwise use Composio's managed app.

**Redirect URI:** with a custom auth config, Google redirects to Composio's callback, not to a Beeline domain. Google review may require the redirect on a domain we own. If so, set up Composio's white-label redirect on a Beeline domain and register that URI on the Cloud client before submission.

## Requested scopes and purpose

| Scope | Sensitivity | User-facing reason and demo action |
| --- | --- | --- |
| `https://www.googleapis.com/auth/youtube.readonly` | Sensitive | List the connected channel's videos when the owner asks. Show a channel and video read. |
| `https://www.googleapis.com/auth/yt-analytics.readonly` | Non-sensitive | Read the owner's channel metrics when the owner asks. Show an Analytics read. |
| `https://www.googleapis.com/auth/youtube.upload` | Sensitive | Upload only a video the owner asks the agent to publish. Show an upload from the owner account. |

No scope allows editing or deleting videos.

## Verification submission copy

**App purpose:** Beeline lets an agent's human owner connect YouTube so that agent can act on the owner's explicit requests in a Beeline Room or direct message. The owner starts Google consent from Workbench or an in-conversation Connect card. The grant is held by Composio for that owner, using Beeline's Google client. Google tokens are never posted into chat. The owner can disconnect from Workbench.

**Why these scopes:** Owners connect YouTube so their Beeline agent can act on their requests: list their videos (readonly), read channel metrics (analytics), and upload only a video the owner asks for. No edit or delete.

**User control:** The owner must tap Connect and complete Google's consent. A denied, cancelled, failed, or expired attempt returns to Connect. The conversation continues only after a successful consent and resumes the original request. Workbench provides Disconnect for the account. A different Room member cannot accept a Google card for that agent's owner-bound grant.

## Demo video script

1. Start with YouTube disconnected in Workbench.
2. In Workbench, tap Connect on YouTube.
3. Show Google's consent screen for the production client, with the client ID visible in the browser URL. Google's unverified-app screen is expected here; continue past it, show the account chooser and the YouTube scope list, and complete consent.
4. Return to Beeline and show YouTube connected in Workbench.
5. Ask the agent to list the channel's videos. Show the channel and video read.
6. Ask the agent for the channel's metrics. Show the Analytics read.
7. Ask the agent to upload a specific video. Show the upload completing on the owner's channel.
8. In Workbench, tap Disconnect on YouTube and show it disconnected.

Record the video against the production OAuth client registered in Composio, and the redirect URI that will be submitted. Review Google's live verification form against this copy and attach the video and any required domain/privacy evidence before submission.

## Status

Data-access verification is **not submitted**. The Verification Center blocks submission with "Missing the following fields for one or more requested scopes: demo video." The demo video is the remaining blocker. No restricted-scope (CASA) security assessment applies, because no restricted scopes are requested. Google review remains an external gate.
