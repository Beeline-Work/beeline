# Codex dot connector reproduction R1

Status: incomplete; no real dot reply has been proved.

The supplied Pidoong screenshot reports that the new Beeline Rooms connector is
absent, an older private bridge fails its check, and Beeline is absent from the
host's event sources. Nothing has been deleted from that account.

On October 31, 2026, Trusty Squire opened ChatGPT. Three drive attempts returned
no actions while the page stayed network-busy. Navigating the same session to
`https://chatgpt.com/codex` exposed the signed-out login page. Google sign-in with
the owner's existing account reached OpenAI's authenticator challenge. A live
browser card was opened for the owner to finish that step. The session is
preserved for handback; inspecting Pidoong's connectors and repeating R1 still
require that sign-in.

The vault lookup for ChatGPT/OpenAI returned no saved credential. The connected
service catalog exposes no ChatGPT dot management app. A host HTTP check reached
Cloudflare's challenge, so it cannot supply authenticated dot evidence either.

OpenAI's [MCP Events documentation](https://developers.openai.com/plugins/build/mcp-events)
explicitly includes dots and says the host supplies and verifies its callback
when asked to monitor an event. Consequently absence of host support has **not**
been established, and a timer fallback has **not** been configured or proved.
Protocol methods must not be presented to the model as callable tools.

Prepared changes distinguish host-managed events from a client-owned webhook,
require connector/identity verification, and describe a host recurring-task
fallback only when events are unavailable. The starter routine and consent/setup
regressions pass locally. These checks establish instruction delivery, not a
real dot wake. No screenshot of a successful reply or Room message ids exist yet.

The built-service stand-in `node --import tsx scripts/prove-rooms-mcp.mjs`
also passes: OAuth sign-in and Allow, Room listing and reading, a Room tag and DM
delivered to a receiver double, MCP replies visible through the phone Room read,
and disconnect revocation. It uses a synthetic identity provider and receiver,
not Pidoong. This demonstrates the underlying user path while MFA blocks the
real target; it does not establish host subscription or timer behavior.

After handback: list installed connectors without deleting the old bridge; add
Beeline Rooms at `https://server.usebeeline.app/mcp`; confirm the dot can list its
Rooms; ask the host to monitor mentions; tag its exact handle in a Room and capture
the reply screenshot and both message ids. If host events actually fail, record
that evidence, configure the recurring `list_mentions` task in the host, and
repeat the same tag/reply proof before declaring completion.
