# Campaign: test-atlas-tutor-partners

product: |
  Test Atlas is an independent digital SAT preparation platform. Students can
  take unlimited full-length digital SAT practice tests for free. Test Atlas
  also offers a Learning Loop that assesses a student, identifies a specific
  question-family weakness, provides a targeted drill, reassesses the student,
  and produces a progress report that can be shared with parents, tutors,
  coaches, or counselors. The first full Learning Loop cycle is free and does
  not require a credit card. Test Atlas is not affiliated with College Board.

audience: |
  Primary audience: independent SAT tutors and small or midsize US test-prep
  businesses that actively serve digital SAT students.

  A prospect qualifies only when all of the following are true:
  - Its official website clearly describes current SAT tutoring, coaching, or
    test-prep services.
  - A business email address is visibly published on the organization's own
    website or official contact page. Never infer or guess an address.
  - The site provides a specific, current detail that supports a genuine
    personalization hook, such as a named SAT program, teaching approach,
    student population, location, or between-session practice model.
  - The recipient is in the United States unless the operator explicitly
    approves a separate jurisdiction-specific campaign.

  Skip students, parents, Reddit users, community moderators, marketplace-only
  tutor profiles, personal email addresses not explicitly published for
  business inquiries, hidden or decoded addresses, generic contact forms with
  no visible email, schools and nonprofits, creators, study-abroad consultants,
  large national companies requiring a partnership pitch, and organizations
  that do not currently offer SAT services. Those audiences require separate
  campaigns and positioning.

offer: |
  Invite the tutor or prep business to try Test Atlas with a small number of
  students at no cost. Their students receive unlimited full-length practice
  tests and one free Learning Loop cycle. Ask for practical feedback about what
  would make the platform more useful between tutoring sessions. Offer either
  email-based onboarding or a short 10-minute walkthrough; never imply that a
  call is required.

positioning: |
  Test Atlas complements the prospect's instruction rather than replacing it.
  Students use full-length practice and targeted drills between sessions, then
  bring concrete results back to their tutor. The tutor keeps ownership of the
  teaching relationship and can use the student's shareable report to focus
  session time and communicate progress. Do not claim that Test Atlas saves a
  specific amount of time or guarantees a score increase.

sender: Alan <alan@testatlas.xyz>
gmail_account: alan@testatlas.xyz
sending_account: alan@testatlas.xyz
send_mode: automated
daily_cap: 20
clump_size: 10
send_window: "Every day, 08:00-09:59 America/New_York"
research_agent_model: gpt-5.6-terra
research_agent_reasoning_effort: medium

research_agent_configuration: |
  Use GPT-5.6 Terra with medium reasoning for prospect-discovery agents only.
  The main campaign agent retains its configured model and reasoning effort for
  central source validation, deduplication, ledger reconciliation, message
  verification, Gmail scheduling, and final reporting.

automation_authorization: |
  Alan explicitly authorized unattended daily sending on 2026-08-02. Prepare
  exactly 20 new, ledger-safe US tutor targets each day. Use Gmail native
  scheduling to send 10 messages at 8:00 AM America/New_York and 10 messages
  at 9:00 AM America/New_York. Never exceed 20 new outreach messages per day.

operator_locked_template: |
  This template is authoritative for all new outreach in this campaign. It was
  recovered from the message sent to charles@1234tutoring.com on July 21, 2026.
  Do not rewrite, expand, shorten, personalize with site-specific hooks, or
  substitute campaign copy from the subject, voice, positioning, offer, CTA,
  or signature sections below.

  The only recipient-specific substitutions allowed are:
  - {greeting_name}: the verified recipient first name, or the organization's
    natural team name when no individual is publicly identified.
  - {business_name}: the verified tutoring business name.

  Subject (fixed):
  New York test prep startup reaching out to offer free practice tests

  CC (fixed):
  lunchboxfortwo@gmail.com

  Plain-text body (preserve the blank lines exactly):

  Hi {greeting_name},

  We’re the cofounders of TestAtlas.xyz, a New York test prep startup. Specifically, we help students prepare for the SAT. Our website has 10 free full-length adaptive Digital SAT practice tests, along with targeted diagnostic drills that identify recurring skill gaps.

  We’re reaching out because we believe {business_name} might find Test Atlas to be a good fit as a free resource for any students preparing for the SAT. We would also appreciate any student/educator feedback in order to improve our product and make it more effective at helping students achieve their dream score.

  We’re happy to answer any questions via email or jump on a short call!

  — the Test Atlas cofounders

formatting_lock: |
  Create both text/plain and text/html alternatives. The HTML body must contain
  exactly five paragraphs matching the five plain-text blocks above, with no
  list, image, attachment, tracking element, extra signature, or added prose.
  Preserve curly apostrophes and the em dash in the closing.

subject: |
  Personalize plainly around the recipient's students or program. Preferred
  pattern: "Full-length SAT practice tests for <Organization> students".
  Do not use clickbait, fake reply prefixes, urgency, or unsupported claims.

voice: |
  Founder-to-educator, concise, direct, and collaborative. Use 4-7 plain-text
  sentences after the greeting. The first substantive sentence must both
  introduce Alan and Test Atlas and include a specific fact from the
  recipient's site, so the email leads with what Test Atlas is without an
  abrupt or generic personalized opener. Explain the product before making the
  ask. Frame Test Atlas as between-session support for the recipient's own
  teaching. Use a reply-first CTA, offer a short walkthrough only as an option,
  and include a natural opt-out line. No images, attachments, tracking links,
  URLs, promo codes, hype, or claims not explicitly allowed below. Sign:

  Best,
  Alan
  Test Atlas

allowed_claims: |
  - Test Atlas is an independent digital SAT preparation platform.
  - Students can take unlimited full-length digital SAT practice tests for free.
  - The first full Learning Loop cycle is free and requires no credit card.
  - The Learning Loop includes assessment, targeted diagnosis, drill, and
    reassessment.
  - Progress reporting can be shared with parents, tutors, coaches, or
    counselors.
  - Test Atlas is seeking feedback from tutors and test-prep professionals.

forbidden_claims: |
  Never claim or imply that Test Atlas currently provides coach, tutor,
  counselor, or instructor accounts; an organization dashboard; automatic
  per-student tutor reporting; roster management; white-labeling; co-branding;
  LMS integration; affiliate payments; trackable signup links; guaranteed or
  typical score increases; official Bluebook or College Board alignment; or a
  partnership already approved by Test Atlas. Never offer paid Learning Loop
  access for free without separate, explicit operator approval.

cta: |
  Preferred form: ask whether they would be open to trying Test Atlas with a
  few students and sharing feedback. Invite them to reply, and offer either
  email-based help getting started or an optional 10-minute walkthrough.

follow_up: |
  At most one short follow-up, no sooner than 7 full days after a confirmed
  delivery. Never follow up after a reply, opt-out, or hard bounce. A
  rate-limit bounce may be retried exactly once on the next eligible day.

source_of_truth: |
  Google Drive folder: Test Atlas outreach
  Folder ID: 1ST-54Kt0Vn-lOTlJtqy0HXWOKj1LlrMn
  Master sheet: Test Atlas - Master Contact List (179 targets)
  Spreadsheet ID: 1341NSsj6fA1Auj6ODBopCfgYr01f59Cf3SPsWwLtt7E
  Gmail account: alan@testatlas.xyz

ledger_migration_gate: |
  Do not gather prospects, create drafts, or send anything until the campaign
  ledger has been reconciled against BOTH the master sheet and Gmail. Import
  every previously drafted, sent, replied, opted-out, and bounced address with
  its real status and dates. Treat any address found in prior Test Atlas
  outreach as already touched even if the master sheet is blank or stale.
  Preserve the master sheet as the operator-facing contact tracker, but use
  ~/.claude/outreach/test-atlas-tutor-partners/ledger.jsonl as the campaign's
  never-contact-twice enforcement ledger. Surface discrepancies for review;
  never resolve them by emailing the contact again.

compliance_note: |
  Automated sending is enabled by Alan's standing authorization dated
  2026-08-02. Before any send, confirm that the recipient and message comply
  with applicable law and honor every opt-out immediately. This campaign is
  intentionally US-only; create separate reviewed campaigns before contacting
  other jurisdictions.
