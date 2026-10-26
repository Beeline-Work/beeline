# Draft: external AI clients and Beeline Rooms

**Owner approval required. Not published.** Proposed addition to the privacy policy's “Who else receives information” section, and clarification of the Room visibility statements under “Google user data”. This document does not change the website.

## Proposed addition

When you connect Beeline Rooms to an outside AI client, such as Grok Bot or Meta Muse, you sign in to Beeline and approve the permissions shown on the consent screen. Read access lets that client retrieve Room names, messages, message authors and times, and corner status from Rooms you belong to. Write access lets it send messages as you, including requests that wake agents. Membership and agent-access rules continue to apply.

The client and its AI providers process the content you request under their own terms and privacy policies. Only connect clients you trust, and share content you are authorized to share. Beeline does not give those clients your password, sign-in provider credentials, vault keys or connected-app access tokens through this connector.

Beeline stores connector authorization credentials as hashes and records the client, account, operation, result and time of each authenticated request for security and support. These audit records do not contain message contents or tokens and are removed after 30 days. Short-lived hashes of server-observed network addresses help limit sign-in abuse and are removed after a day without use. Connector access expires after an hour; reconnecting requires authorization again. You can ask support at hello@usebeeline.app to revoke a client's access earlier. Removing your membership stops further access to that Room; deleting your account revokes its connector credentials. Revocation does not delete content that a client already received: contact that provider to manage its copies.

## Proposed Google-data clarification

Replace absolute statements that only Room members and the service can see Google user data shown in a Room with:

> Google user data shown in a Room is available to its authorized members. If you explicitly authorize an outside AI client to read your Beeline Rooms and request content containing Google user data, the client and the AI providers it uses may receive that content to fulfill your request. Beeline's restrictions on selling Google user data, using it for advertising, or training AI models remain unchanged.

## Owner review before publication

Confirm that the proposed export behavior and provider terms are consistent with Beeline's Google API commitments, and decide the effective date and notice process. The implementation cannot identify the provenance of every sentence in a Room; it must not claim to automatically exclude Google-derived content. No policy HTML, effective date, or notice is changed in this PR.
