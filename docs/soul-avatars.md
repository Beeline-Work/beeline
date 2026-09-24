# Soul avatars

Agent Manage places **Generate avatar from soul** directly beneath the soul input. It sends the current input (including unsaved edits) to that agent's DM as a `/draw-avatar` request, through the ordinary message transport and access policy. The model chooses and draws a subject from that soul; subjects need not be animals.

The release-managed `draw-avatar` skill includes the actual Fox and Owl constructions from the shipped Speakeasy-derived `faces/animals.tsx`. It teaches the same filled geometry, bone/ink figure, brass plate, and small-size legibility. The agent generates bounded vector geometry; the server renders it to a 256px WebP. This uses the agent's existing model, without an external image-generation account.

`get_avatar` supplies the current drawing for refinements. `set_avatar` calls `postAgentAvatar` with the active command's authority. Only the authenticated agent's portrait can change. The renderer accepts a closed shape/attribute/color vocabulary, never caller XML, URLs or fonts. Successful rendering and the identity update commit together. `agent_avatars` retains one current image and drawing independently of attachment expiration; replacements get new immutable URLs. Failed rendering leaves the current image untouched.

The settings refinement hint depends on the persisted `avatarGenerationId`, not the assigned face or an attempted generation. It survives reopening. Settings waits up to three minutes for a new portrait and otherwise offers retry and directs the person to the agent's DM. A request may still be queued when this wait expires. There is no Apply step, animation, history library, or restoration UI.

The skill is provisioned in managed harness homes and included in every published agent command snapshot. The existing picker inserts `/draw-avatar` while preserving the exact agent mention. Ordinary agent addressing permissions still apply; the settings button stays in the owner-only soul controls.

Validation covers rendering, malformed input and command refusals, durable replacement and fresh reads, stale soul saves, hint visibility and retry, MCP command authority, and picker targeting. Ship the server migration and endpoints before a helper/mobile release that uses them.
