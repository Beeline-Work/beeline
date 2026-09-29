---
name: outreach
description: Daily small-batch cold outreach — gather niche prospects with publicly listed emails, write personalization-gated offers, create Gmail DRAFTS for human review/send (or automate via a browser-automation vault on a dedicated mailbox), and track a never-email-twice ledger with reply triage. Campaign-agnostic; everything product-specific lives in campaigns/*.md. Use when the user says "run outreach", "outreach batch", or /outreach.
---

# Outreach — gather → personalize → draft → track

Runs ONE daily batch for a campaign. Drafts-first: by default this skill NEVER
sends email — it creates Gmail drafts and a human reviews and sends. Graduating
to automated sending is a deliberate, user-approved config change
(`send_mode: automated`), never a default.

## Invocation
`/outreach <campaign>` (default: the only file in campaigns/). A campaign
config in `campaigns/<name>.md` defines: product, offer, audience search spec,
positioning frame, sender identity, daily cap, voice rules, send window. See
`campaigns/example-campaign.md`. The skill contains NO product specifics —
if you find any, that's a bug.

## Ledger (the heart of the skill)
`~/.claude/outreach/<campaign>/ledger.jsonl` — one JSON object per prospect
ever touched: {email, name, business, url, hook, drafted_at, status, ...}.
Statuses: drafted | queued | sent | replied_interested | replied_call |
opted_out | bounced | bounced_ratelimit | skipped.
- NEVER email an address already in the ledger, in any status. The single
  exception: bounced_ratelimit (the message never arrived) gets exactly one
  resend.
- Opt-outs are permanent and campaign-independent: also append them to
  `~/.claude/outreach/global-optout.jsonl` and check it for every campaign.
- Only ONE machine may own a campaign's ledger at a time. Moving machines =
  moving the whole `~/.claude/outreach/` directory and retiring the old copy.

## Stages

### 1. Gather (parallel agents)
Fan out 2-3 research agents over distinct regions/channels for prospects
matching the campaign's audience spec. STRICT RULES (put verbatim in agent
prompts):
- Only emails ACTUALLY SEEN in fetched page content (mailto link or printed
  text). Never guess or pattern-infer an address (no assuming info@domain).
  Skip marketplace/platform profiles that hide emails. Skip emails that are
  only recoverable by decoding bot-protection — that's circumvention, not a
  public listing.
- Capture one SPECIFIC personalization hook per prospect, quoted or closely
  paraphrased from their site, plus the source URL.
Agents return JSONL. Then: dedupe against the ledger, the global opt-out list,
and each other; sanity-check addresses; spot-check a few entries by fetching
their source URLs before trusting a new agent's output. Surplus vetted
prospects go to `bench.jsonl` — tomorrow's batch starts there.

### 2. Write (quality-gated)
One individual email per prospect. Rules:
- The first line proves you read THEIR site (use the hook). No genuine hook →
  status=skipped. Never fall back to a template opener. The gate IS the product.
- Positioning comes from the campaign config's `positioning:` — typically:
  frame the offer as leverage for the prospect's own business, never as a
  replacement for what they do.
- 4-7 sentences, plain text, no images, no attachments.
- NO URLs in the body. Two reasons: zero-link cold emails have the best
  deliverability, and some Gmail draft connectors rewrite any URL-shaped text
  (bare domain or https) into a google.com/url redirect wrapper at draft
  creation. Brand name in prose only; a from/cc address on your product domain
  carries the domain visibly in headers.
- CTA: reply-first ("just reply and we'll set you up") — replies are the
  strongest deliverability signal and the start of a conversation. Avoid promo
  codes unless the campaign config names one that VERIFIABLY exists.
- Include a soft call offer and a human-voiced opt-out line. Know your local
  law: e.g. US CAN-SPAM requires a physical mailing address and honoring
  opt-outs; other jurisdictions (GDPR/PECR, CASL) are stricter. Compliance is
  the operator's responsibility.
- Subject: plain and earnest, not clever. State who you are and what you're
  offering (e.g. "<city> <industry> startup reaching out to offer <thing>").
  Clever subject lines read as automated slop; earnest ones read as a founder.

### 3. Draft (default mode)
Create one Gmail draft per email via the Gmail connector's create_draft tool.
Append each prospect to the ledger (status=drafted). Report the batch: count,
recipient list, 2-3 full samples. THE HUMAN SENDS THEM — and should send in
clumps (see Pacing), not all at once.

### 3-alt. Automated sending (send_mode: automated)
Only when the campaign config says so, and ONLY from a dedicated mailbox on
your product's domain — NEVER anyone's personal account. A personal account is
an identity anchor; the dedicated mailbox is deliberately expendable.
- One-time setup, human present: capture the mailbox login into a
  browser-automation credential vault (e.g. Trusty Squire's operate flow) so
  the agent can drive a real webmail session without the password ever
  entering chat.
- Per scheduled run (hourly, inside the campaign's send window): pull up to
  `clump_size` (default 3) queued entries; compose and send each manually in
  the browser (To/Subject/Body VERBATIM from the queue record — never rewrite
  at send time); wait a randomized 2-5 minutes between sends.
- After each clump, check the inbox for mailer-daemon bounces. Rate-limit
  bounce ("reached a limit for sending") → mark bounced_ratelimit and HALT all
  runs for 24h. Hard bounce → mark bounced, never retry.
- When a campaign config defines an email verifier, require a fresh passing
  result before creating or sending each first-touch message. Treat invalid
  results as permanent skips and catch-all, unknown, provider errors, or
  missing credentials as human-review holds. Keep the provider result and
  timestamp in campaign state so the draft/send path can independently enforce
  the gate. Do not reverify an address for an explicitly authorized follow-up
  after the original message was confirmed delivered.
- Update the ledger after EVERY send. Refill the queue from bench + gather
  when empty. Never auto-reply to prospects.

### 4. Replies (every run, before anything else)
Search the sending inbox for replies from ledger addresses. Classify:
interested / call request / opt-out / bounce. Update the ledger, append
opt-outs to the global list, and surface interested/call replies to the human
FIRST — reply handling beats new volume, always.

## Pacing (learned the hard way)
Gmail throttles BURSTS, not just daily totals: ~30 near-identical sends within
a couple of minutes will trip "You have reached a limit for sending mail"
partway through, and the throttled messages are NOT delivered. Rules:
- Send in clumps of 8-10 manually (or 3 automated), spaced 1-2 hours apart.
- Never more than ~10 sends in any 10-minute window.
- Default daily cap 20-30; one batch per day.
- Follow-up policy: at most ONE polite bump to non-repliers, 7+ days after the
  send, ever. Never bump opted-out/bounced/replied prospects.

## Hard rules
- Personal email accounts are draft-only forever. Automated sending only from
  a dedicated mailbox, only after the user explicitly flips send_mode.
- Never invent product claims; offer text comes from the campaign config.
- Never reference a promo/access code without verifying it exists.
- The never-twice ledger and the opt-out list are inviolable. When in doubt,
  don't send.
