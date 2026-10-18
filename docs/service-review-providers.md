# Verified service-review processing path

Verified on October 18, 2026, using authorized configuration metadata only. No
workspace messages or activities were read to establish this inventory.

The matching daily feedback-triage schedule belongs to a Claude harness with
selected model `default`. The commander binds the browse step to that same
triager. The current model provider is **Anthropic**, supported by the configured
harness and its authenticated provider endpoints in
`apps/body/src/claude-sign-in.ts` and `apps/body/src/provider-key-check.ts`.
The public Privacy Policy remains vendor-neutral; the subprocessors page names
the current review provider.

The data path is:

1. **Trusty Squire** receives the read-only query and injects the vaulted database
   connection in the request. Its proxy receives the returned workspace rows and
   passes them back to the agent. No database credential is returned to the agent.
2. **Neon** hosts the queried database. The authorized connection metadata names
   a Neon endpoint, and the HTTP SQL route uses `Neon-Batch-Read-Only: true`.
3. **Anthropic** processes the returned content when the scheduled Claude triager
   reviews it and produces findings.
4. **Fly.io** hosts Squire's API/database infrastructure as disclosed by Squire.
   Its existing subprocessors row covers this processing infrastructure too.

The Squire and Neon rows describe returned workspace content, not just credential
metadata. The existing repository privacy policy already lists these external
services; no first-party-only component is added as a subprocessor.

The external proxy behavior and hosting are documented by the
[Trusty Squire Privacy Policy](https://trustysquire.ai/privacy) and
[Terms of Service](https://trustysquire.ai/terms). Repository support includes
`apps/body/src/external-mcp-capabilities.ts`, `docs/feedback-loop.md` and the
previous published privacy policy. The authorized metadata query selected only
schedule cadence, agent harness and selected model; it never selected secrets,
message bodies, prompts, workspace names or user content.

The workflow reserves its reads before dispatch. The configured agent is checked
against the published model-provider inventory before reservation and again in
every read-only SQL function. Only the verified Claude/Anthropic route is currently
allowed; unknown harness/model combinations or a switch to another provider fail
before workspace content is returned. The test suite also checks that the public
page's named service-review model providers match that executable inventory.
