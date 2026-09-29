# Campaign: test-atlas-school-partners

product: |
  Test Atlas is an independent digital SAT preparation platform. It provides
  free full-length digital SAT practice tests with clear explanations and
  targeted drills that help students identify recurring skill gaps. Test Atlas
  is not affiliated with College Board.

audience: |
  US school and district personnel with a confirmed position of authority who
  support a school serving at least one high-school grade. Qualifying roles
  include counseling and guidance, principals and other school leaders,
  registrars and student-services staff, college/career/CTE staff, program or
  department leaders, and district leaders.

  A recipient qualifies only when all of the following are true:
  - The contact was discovered by the Test Atlas deterministic school crawler,
    not inherited from the legacy contact import.
  - The email address and position are confirmed from a publicly accessible
    official school or district page. Never guess or pattern-infer an address.
  - The contact is assigned in the master workbook to a school serving grade
    9, 10, 11, or 12.
  - Outreach Ready is Yes, Outreach Status is not_contacted, and Do Not Contact
    is No in the live master workbook.
  - The address is absent from this campaign's ledger, every other Test Atlas
    outreach ledger, the global opt-out file, and prior Gmail campaign mail.

offer: |
  Offer a free SAT practice resource that may be useful to the recipient's
  students. Ask the recipient to reply for a short overview and access details,
  or to point Alan to the appropriate person at the school.

positioning: |
  The message must work for any confirmed school authority. Never assume the
  recipient is a guidance counselor and never mention or infer responsibilities
  beyond the verified school association. Position data is a qualification
  gate, not a message-personalization field.

sender: Alan <alan@testatlas.xyz>
gmail_account: alan@testatlas.xyz
sending_account: alan@testatlas.xyz
send_mode: automated
daily_cap: 50
clump_size: 10
intended_send_window: "Every day, five normal hourly batches at 08:00, 09:00, 10:00, 11:00, and 12:00 America/New_York, with conditional catch-up opportunities at 13:00, 14:00, and 16:00"

automation_state: |
  Alan authorized unattended daily sending on 2026-08-22. The former
  tutor-partners timer is disabled. Run five normal hourly groups at 08:00,
  09:00, 10:00, 11:00, and 12:00 America/New_York. Each hourly job owns one
  ten-message batch and paces its messages rather than sending a simultaneous
  burst. Separate non-persistent catch-up opportunities run at 13:00, 14:00,
  and 16:00 every calendar day. They perform a local, lock-protected
  Gmail-confirmed-attempt count and exit before Codex when the count is already
  50; otherwise they invoke the same production clump for at most
  min(10, 50-count) messages. Each clump performs its own Gmail Sent, MIME,
  reply/bounce, and master-workbook readback verification. The former overlapping half-hour verifier is
  disabled so it cannot hold the campaign lock across the next hourly batch.
  Production sending uses the connected Gmail draft/send path after verifying
  the profile is exactly alan@testatlas.xyz; the browser/UI sender is retired.
  Separate inbox-review jobs run daily at 15:00 and 20:00 America/New_York.
  Each first performs a cursor-based Gmail scan with a 20-minute overlap and
  immutable message-ID deduplication. The Google Sheets reconciliation path is
  loaded only when a local event is pending, then exact workbook readback is
  required before that event is marked synced. The review classifies replies
  and delivery notices, records temporary delivery delays without invalidating
  the address, reconciles terminal hard bounces, and schedules eligible
  out-of-office follow-ups.

email_verification: |
  Every new-outreach recipient must pass ZeroBounce immediately before a draft
  is created. Store the provider status, sub-status, decision, and check time in
  the queue and ledger. Only `valid` is a pass. Invalid, spam-trap, abuse, and
  do-not-mail results are permanent skips. Catch-all and unknown results are
  holds for human review, as are provider errors or missing credentials. The
  state tool refuses to render a new-outreach draft unless the recorded pass is
  no more than seven days old. An out-of-office follow-up does not need another
  check because the original message was Gmail-confirmed and did not hard
  bounce. Historical evaluation uses confirmed hard bounces as positives and
  Gmail-confirmed sends without a recorded hard bounce as a delivery proxy;
  neither the proxy nor a retrospective verifier result proves inbox placement
  or reconstructs the mailbox state at send time.
  The API key is read from ZEROBOUNCE_API_KEY or from the single
  ZEROBOUNCE_API_KEY entry in the mode-600 file
  /home/alan/.config/test-atlas/outreach-verifier.env. The clump runner exits
  before reservation when neither source is configured.

school_deduplication: |
  Keep only one active outreach contact per School ID at a time. After a
  Gmail-confirmed delivery, hold every other contact assigned to that school
  for 14 full days. If the first contact has not replied after the cooldown,
  the next eligible authority at that school may be contacted. Any human reply
  from the school stops the sequence; do not contact another staff member. A
  hard bounce may release the school for a different verified contact after the
  bounce is reconciled. Email-level ledger and global-opt-out suppression remain
  permanent. When several contacts are available, prefer a named college/career
  or counseling contact, then student services, then school leadership, then
  another confirmed authority.

operator_locked_template: |
  This template is authoritative for all new outreach in this campaign. Alan
  approved it on 2026-08-22. Do not rewrite, expand, shorten, add a URL, add a
  role-specific statement, add a personalization hook, or add extra prose at
  draft or send time.

  The only recipient-specific substitutions allowed are:
  - {greeting}: "Hi {first_name}," when a verified name is present; otherwise
    exactly "Hello,".
  - {school_name}: the school assigned to the contact in the master workbook.

  Subject:
  Free SAT practice resource for {school_name}

  Plain-text body (preserve the blank lines exactly):

  {greeting}

  I’m Alan, a cofounder of Test Atlas, a New York SAT-prep startup. We created a free SAT practice resource that may be useful to students at {school_name}.

  Test Atlas offers full-length digital SAT practice tests with clear explanations, along with targeted drills that help students identify recurring skill gaps.

  If this sounds potentially useful for your school, just reply and I’ll send a short overview and access details. If someone else handles SAT resources, I’d appreciate it if you could point me in the right direction.

  Best,
  Alan
  Test Atlas

formatting_lock: |
  Create both text/plain and text/html alternatives. The HTML body must contain
  exactly five paragraphs matching the five plain-text blocks above, with the
  final Best/Alan/Test Atlas block separated by HTML line breaks. Use no wrapper
  content, images, attachments, tracking elements, links, or extra signature.
  Preserve the curly apostrophes and the SAT-prep hyphen.

operator_override: |
  Alan explicitly removed the sentence "If you’d rather not hear from me again,
  just let me know." on 2026-08-22. Do not restore it or substitute another
  opt-out sentence while this template remains locked.

  Alan also directed the campaign on 2026-08-22 to proceed without adding a
  postal footer and without stopping the existing warming service. Preserve
  the locked body exactly; do not silently add either item at send time.

tracking: |
  The campaign ledger is
  /home/alan/.claude/outreach/test-atlas-school-partners/ledger.jsonl. The global
  opt-out file is /home/alan/.claude/outreach/global-optout.jsonl. After every
  Gmail-confirmed send, update every matching contact assignment in the master
  workbook only for the contact assignment whose School ID matches the sent
  message, and append an event to Outreach Activity with that same School ID.
  If the same authority is assigned to another school, leave that other
  assignment untouched. Never mark a message sent before Gmail confirms it in
  Sent. A hard bounce must also update that exact assignment to the workbook's
  validation-backed Outreach Status `hard_bounce` and Do Not Contact Yes,
  preserve its send timestamp, append the
  diagnostic and bounce-notice ID to Notes, and add one deduplicated Outreach
  Activity bounce event. The local record remains master-sync-pending until
  connector readback proves those workbook changes.

source_of_truth: |
  Master workbook: Test Atlas School Outreach Master
  Spreadsheet ID: 1LxSJGPz4ch3yz9d9h70rBSvyN_nqFKIDqWhjLjEdAcI
  Contacts sheet crawler provenance begins at row 8444. Row position alone is
  not sufficient: Email Evidence must be official_page_verified and Position
  Status must be confirmed.

follow_up: |
  Alan authorized one narrowly scoped follow-up after a confirmed out-of-office
  automatic reply on 2026-08-22. This is the only repeat message authorized.
  When the automatic reply gives a return date, allow three full business days
  after that date and make the follow-up eligible on the next business morning.
  When no reliable return date is present, allow seven full business days after
  the automatic reply and make it eligible on the next business morning. In all
  cases the follow-up must also be at least seven calendar days after the first
  send. A human reply, opt-out, hard bounce, role-change referral, or prior
  follow-up cancels it. Only one follow-up may ever be sent to the address.

  Eligible follow-ups take priority over new contacts in the regular 08:00-
  12:00 hourly send clumps and count toward the same 50-message daily cap. Send
  them as replies in the original Gmail thread with this exact plain-text body,
  substituting only the locked greeting and school name:

  {greeting}

  I wanted to follow up on my note about the free SAT practice resource for {school_name}. If it could be useful for your students, I’d be happy to send a short overview and access details.

  Best,
  Alan
  Test Atlas

  Preserve the same plain multipart formatting discipline as the initial
  outreach. Do not add links, a footer, an opt-out sentence, quoted prose, or
  any other content. When a school has not replied and no out-of-office
  follow-up is pending, a different eligible authority may enter the sequence
  after the 14-day school cooldown. Any human reply ends further school-level
  outreach. Never auto-reply conversationally to prospects.
