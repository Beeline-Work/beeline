# Push sensitivity

Reproduction PUSH-LEVELS: with the default My work preference, a requester belongs to a corner and its agent completes an untagged turn. Before this change the delivery loop sent zero pushes. The service-path regression now sends one push containing the final message.

The existing stored `direct` and `mine` preferences become Mentions only and My work. `all` adds activity in member Rooms and corners. My work remains the default; the existing Off preference remains available. Explicit replies already use `messages.reply_to_message_id`; no new reply field was needed.

Activity notifications replace a conversation slot. Human activity uses the conversation id, agent activity uses `agent:<conversation id>` so a finished agent turn cannot hide a human message. Attention uses a message id, with consecutive human attention messages sharing their first message's slot for up to 20 seconds. Android taps and inline actions deduplicate the payload's message id so the next replacement remains actionable. APNs uses matching collapse and thread keys; web pushes use matching tags. Existing member-lifecycle and release delivery remain available.

Mute lives on Room membership and applies to every sensitivity. Foreground views have independent 45-second device-session leases, renewed every 20 seconds and released on leaving or backgrounding. Read marks suppress already-read messages and messages received within 30 seconds of reading on any device. Suppression consumes the delivery claim so closing a view does not replay a backlog.

Verification:

- `npm test -w @beeline/server -- --run src/push-sensitivity.test.ts` exercises persisted levels, human messages and explicit replies through PhoneService, and agent completion through the real database and delivery worker; it prints the observed delivery results.
- Background, provider, migration, corner-owed and release-catchup suites cover existing delivery paths and the new keys.
- `PUSH_PROOF_OUT=../../docs/evidence/push-sensitivity npm test --prefix apps/mobile -- --run sources/test/push-sensitivity.browser.test.ts` builds the real picker for headless Chrome at phone and desktop widths in Obsidian and Bone. The screenshots here use real fonts and theme tokens; device services are shimmed.
- Notification response/action regressions exercise taps and replies after reusing a collapse tag; the mobile design lints and root typecheck cover the changed UI and contract.

The host has no configured Android AVD. Device-provider acceptance and operating-system notification replacement were not tested live; payload tests verify Android/APNs/web keys, and browser tests verify the picker and tap routing.
