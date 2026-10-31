# Codex dot connector reproduction R1

Status: connector and host mention subscription confirmed by Pidoong; the Room tag/reply proof remains incomplete.

The supplied Pidoong screenshot reports that the new Beeline Rooms connector is
absent, an older private bridge fails its check, and Beeline is absent from the
host's event sources. Nothing has been deleted from that account.

On October 31, 2026, Trusty Squire opened ChatGPT. Three drive attempts returned
no actions while the page stayed network-busy. Navigating the same session to
`https://chatgpt.com/codex` exposed the signed-out login page. Google sign-in with
the owner's existing account reached OpenAI's authenticator challenge. A live
browser card was opened for the owner to finish that step. The session is
preserved for handback. The owner subsequently completed sign-in; ChatGPT
Settings confirmed Bento Maker, @lunchboxfortwo, lunchboxfortwo@gmail.com.

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

## Real dot connection after handback

The installed old plugin is **Pidoong Beeline Connector**, connected on October
29, with MCP URL `https://pidoong-beeline-bridge.lunchboxfortwo.chatgpt.site/mcp`.
It was preserved. The installed list initially had no Beeline Rooms entry.

The working creation path was Plugins → Add → Add custom MCP server → name
Beeline Rooms → server `https://server.usebeeline.app/mcp` → OAuth → acknowledge
trusted-server warning → Create as a plugin → Beeline Google sign-in → Edit
member → Pidoong / `pidoong_dot` → Allow, with webhook fields empty.

Pidoong then used the connector and reported:

- Member: `67c0f568a77348f6b3ad6946fedef0ad4869929ca1f02b4ed93612d199a4164e`
- Handle: `@pidoong_dot`
- Owner: Bento Maker (`@lunchboxfortwo2`) in Beeline
- Room: `#general`, `386f0743-eceb-4d8d-85c1-2c326720da0a`

The Google Beeline identity has a different handle from the existing Room owner;
this is the Room actually returned by the real dot, not an inferred membership
in the development Room. The model confirmed its mention subscription is enabled
and that it will send threaded replies. It explicitly said no event has fired
yet. Host event support is therefore available at least through subscription
setup; a timer fallback is not justified by the current evidence.

For the final tag, Beeline web was initially signed in as Play Review. That test
account was signed out without changing its data. Google sign-in for the owner
then remained loading with both sign-in buttons disabled. The existing live
browser card was left on that page for the owner to complete the browser
handoff. No test tag or reply message ids have yet been obtained.
