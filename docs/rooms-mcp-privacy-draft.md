# Draft: external AI clients and Beeline Rooms

**Owner approval required. Not published.** Proposed addition to the privacy policy's “Who else receives information” section, with the existing “Google user data” section left unchanged. This document does not change the website.

## Proposed addition

When you connect Beeline Rooms to an outside AI client, such as Grok Bot or Meta Muse, you sign in to Beeline and approve the permissions shown on the consent screen. Read access lets that client retrieve Room names, messages, message authors and times, and corner status from Rooms you belong to. Write access lets it send messages as you, including requests that wake agents. Membership and agent-access rules continue to apply.

The client and its AI providers process the content you request under their own terms and privacy policies. Only connect clients you trust, and share content you are authorized to share. Beeline does not give those clients your password, sign-in provider credentials, vault keys or connected-app access tokens through this connector.

Beeline stores connector authorization credentials as hashes and records the client, account, operation, result and time of each authenticated request for security and support. These audit records do not contain message contents or tokens and are removed after 30 days. Short-lived hashes of server-observed network addresses help limit sign-in abuse and are removed after a day without use. Access tokens expire after an hour and refresh automatically while your connection remains active. You can disconnect a client at any time in Settings → Connectors → AI clients. Disconnecting revokes its access and refresh credentials for your account. Removing your membership stops further access to that Room; deleting your account revokes its connector credentials. Revocation does not delete content that a client already received: contact that provider to manage its copies.

## Google user data remains unchanged

This proposal does not change the existing Google user data section or authorize new sharing of Gmail, Drive, or Calendar content with outside AI providers. Users are responsible for choosing content they are permitted to share with an external client.

## Owner review before publication

Confirm the addition, effective date and notice process. The implementation cannot identify the provenance of every sentence in a Room and does not claim to automatically exclude Google-derived content. No policy HTML, Google-data clause, effective date, or notice is changed in this PR.
