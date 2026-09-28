# Google Workspace OAuth verification draft

The Cloud OAuth consent screen is in **In production**. Its branding is verified; data access is not yet verified. The production redirect is `https://server.usebeeline.app/v1/google/oauth/callback`. Keep the Cloud client ID and secret aligned with the deployed server without copying either secret into this document. On 2026-09-28, the unused `gmail.send`, `gmail.compose`, and `calendar.events` declarations were removed from the production project's Data Access page; Google confirmed the changes were saved. The retained declarations are Calendar read, Gmail read, Drive read, YouTube read, and YouTube Analytics read.

## Requested scopes and purpose

The server-owned consent URL requests `openid` and `email` plus the selected tool's scopes. Later consent adds only scopes for tools the same person previously connected and the tool they selected now. The Google Workspace parent action starts with Calendar. The individual tool rows and conversation cards select their named tool.

| Selected tool | Scope | User-facing reason and demo action |
| --- | --- | --- |
| Calendar | `https://www.googleapis.com/auth/calendar.readonly` | Read the person's upcoming primary-calendar events to answer a Room or DM request. Show an agent listing events after the person approves the card. |
| Gmail | `https://www.googleapis.com/auth/gmail.readonly` | Read messages that the person asks an agent to find or summarize. Show a message search and a selected message. The current Room tool cannot send or compose mail. |
| Drive | `https://www.googleapis.com/auth/drive.readonly` | List non-trashed files the person asks about. Show a file listing after consent. |
| YouTube | `https://www.googleapis.com/auth/youtube.readonly` and `https://www.googleapis.com/auth/yt-analytics.readonly` | Read the connected channel's videos and owner Analytics when the person selects YouTube. Show channel, video, and Analytics queries from the owner account. |

The legacy helper-paired path still requests a combined set of the retained scopes. The new direct path uses the table above. No consent flow requests Analytics or Gmail just to read Calendar.

## Verification submission copy

**App purpose:** Beeline lets an agent's human owner connect selected Google Workspace tools so that agent can answer the owner's explicit requests in a Beeline Room or direct message. The owner starts Google consent from Workbench or an in-conversation Connect card. Beeline stores a renewable grant on the server, scoped to that owner. Google tokens are never posted into chat. The owner can disconnect from Workbench.

**Why these scopes:** Calendar read access supplies upcoming events; Gmail read access supplies search and message reading; Drive read access supplies file listings; YouTube read and Analytics access supply channel content and owner metrics. Each tool is offered separately. Agents receive a short-lived access token only when their owner is a current Workspace member and the relevant scope is present.

**User control:** The owner must tap Connect and complete Google's consent. A denied, cancelled, failed, or expired attempt returns to Connect. The conversation continues only after a successful consent for the selected tool and resumes the original request. Workbench provides Disconnect for the account. A different Room member cannot accept a Google card for that agent's owner-bound grant.

## Demo video script

1. Start with Google disconnected in Workbench; show the four tool rows and the unverified-app explanation.
2. In a Room, ask an agent to read upcoming Calendar events. Show the Calendar Connect card and tap once. Show Google's account chooser, scope list containing Calendar read access but no Gmail, Drive, or YouTube scope, and complete consent. If Google displays its unverified-app warning, show **Advanced → Go to Beeline**.
3. Return to the same Room. Show the accepted card, the agent resuming the original Calendar request, and the event answer. Repeat the card flow in a DM.
4. Show a cancelled attempt returning to a clean Connect action. Retry successfully.
5. In Workbench, select Gmail, Drive, and YouTube separately and show each consent scope list and matching tool result. Show Disconnect.

Record the video against the production OAuth client and production callback after deployment. Review Google's live verification form against this copy and attach the video and any required domain/privacy/security evidence before submission. The data-access verification is **not submitted**; Google review, and any required restricted-scope assessment, remain external gates. Until approval, Workbench tells users how to proceed through Google's warning.
