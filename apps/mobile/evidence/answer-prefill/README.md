# R1 — agent answer composer prefill

Path: Giselle sends `@charles can you find me this for luna?` in a shared Room; Charles answers without a mention or quote reply, with `requestId` referencing her message. Another human views the same transcript.

The local Chrome stand-in renders two real `ConversationComposer` instances, delivers the agent answer after mount, and applies the production candidate and prefill planner. Browser/device integration dependencies use the existing `webProofShims`; speech is unavailable. This isolates the affected composer path without sending production messages.

- Original code: requester tag absent; browser assertion fails ([before](before.png)).
- Fixed code: requester composer shows `@charles`; other viewer has no tag; browser assertion passes ([after](after.png)).
- Unit regression covers both message `id` and `relayId`, another viewer, and an unloaded request. Existing absent-request and mention/quote-reply behavior remains covered.

Run from the repository root:

```sh
npm --prefix apps/mobile test -- --run sources/buzz/composer-prefill.test.ts sources/buzz/composer-prefill.browser.test.ts sources/buzz/message-reply.test.ts
```

28 tests pass, including the real composer Chrome proof.

## Production limitation

Trusty Squire opened `https://web.usebeeline.app` in the existing lunchboxfortwo session. Connectors confirmed the saved reviewer bypass, but secure `operate_login(load_saved)` for its single `value` field returned `unsupported_credential_type`. No secret was retrieved, no message was sent, and this feature branch was not deployed. The requested reviewer-bypass multi-human production interaction and screenshot remain outstanding. After deployment and a supported secure reviewer sign-in route, send an addressed agent message, wait for its untagged answer, and capture the automatically tagged composer. The screenshots here are explicitly local component proof, not production evidence.
