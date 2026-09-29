# outreach-skill

A campaign-agnostic cold-outreach skill for [Claude Code](https://claude.com/claude-code)
(and any agent that reads a SKILL.md): gather niche prospects with *publicly
listed* emails, write personalization-gated one-off emails, create Gmail
drafts for a human to review and send, and keep a permanent
never-email-twice ledger with reply triage. Built and battle-tested running a
real startup's beta outreach; every rule in here was learned by tripping over
its absence.

## Philosophy
- **Drafts-first.** The agent writes; a human sends. Automated sending exists
  but is opt-in, paced like a human, and only ever from a dedicated mailbox.
- **The personalization gate is the product.** No genuine, specific hook from
  the prospect's own site → no email. Skipping beats templating.
- **The ledger is inviolable.** One file per campaign records everyone ever
  touched; nobody gets emailed twice; opt-outs are global and permanent.
- **Earnest beats clever.** Plain subjects, founder voice, feedback-first ask,
  reply-first CTA, zero links.

## Install
Copy this folder to `<your-project>/.claude/skills/outreach/`
(or `~/.claude/skills/outreach/` for all projects). Then:

1. Copy `campaigns/example-campaign.md` → `campaigns/<your-campaign>.md` and
   fill it in. All product/audience/voice specifics live there.
2. Connect a Gmail MCP (for draft creation) in your agent.
3. Say `/outreach <your-campaign>`.

Campaign state (ledger, bench, opt-outs) is created under
`~/.claude/outreach/` — outside your repo, because it contains third-party
contact data.

## Operational lessons baked in
- Gmail throttles **bursts**: ~30 sends in two minutes bounces the tail with
  "reached a limit for sending" — send in spaced clumps (rules included).
- Some Gmail draft connectors **rewrite any URL in the body** into a
  google.com/url redirect wrapper. Zero-link bodies avoid it and inbox better.
- Rate-limit bounces were never delivered — retry once, next day. Hard
  bounces never retry.
- Reply triage before new volume, every run.


## Using with OpenAI Codex

The skill is plain markdown instructions, so Codex CLI can run it — only the
install conventions differ:

1. **Get the files.** Clone this repo somewhere stable, e.g.
   `git clone https://github.com/lunchboxfortwo/outreach-skill ~/outreach-skill`,
   and create your campaign file in `~/outreach-skill/campaigns/`.
2. **Wire it up, either way:**
   - *Custom prompt:* create `~/.codex/prompts/outreach.md` containing:
     "Read ~/outreach-skill/SKILL.md in full and execute one outreach batch for
     the campaign in ~/outreach-skill/campaigns/, following every rule in it."
     Then `/outreach` inside Codex runs a batch.
   - *Project instructions:* or add the same line to your project's `AGENTS.md`
     so any outreach request routes through the skill.
3. **Connect the tools** in `~/.codex/config.toml` under `[mcp_servers.*]`:
   - a Gmail MCP server that can create drafts (any implementation works — the
     workflow only needs "create a draft" and "search threads"; adapt tool
     names to whatever your server exposes);
   - optionally Trusty Squire (or an equivalent browser-automation credential
     vault) if you flip a campaign to `send_mode: automated`.
4. **No sub-agent fan-out?** Claude Code runs the gather stage as parallel
   research agents; if your agent can't, run the same searches sequentially —
   every gather rule (seen-emails-only, personalization hooks, dedupe,
   spot-checks) applies unchanged.

State still lives in `~/.claude/outreach/` by default; feel free to relocate
it (e.g. `~/.outreach/`) — just use one location consistently, since the
ledger is the never-email-twice guarantee.

## Compliance
This tool helps you send *small-batch, personalized, opt-out-honoring* email
to businesses with publicly listed addresses. Whether that is lawful is on
you: CAN-SPAM (US), GDPR/PECR (EU/UK), CASL (Canada) differ. Don't spam.

## License
MIT
