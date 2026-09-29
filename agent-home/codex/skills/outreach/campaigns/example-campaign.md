# Campaign: example-campaign  (copy this file, rename, fill in)

product: Acme Widget — acmewidget.example
audience: |
  Who to find, where their emails are publicly listed, what to skip.
  Example: independent piano teachers in the US with contact emails on their
  own studio websites (no marketplaces, no chains).
offer: |
  What they get, in one honest paragraph. Example: free use of Acme Widget for
  their students while in beta; we set them up when they reply.
positioning: |
  The frame that makes the offer leverage for THEIR business rather than a
  threat to it. Example: students practice between lessons; the teacher sees
  progress; results make the teacher look good.
sender: Your Name <you@yourdomain.example>     # drafts-only unless send_mode: automated
sending_account: outreach@yourdomain.example   # automated mode only; NEVER personal
send_mode: drafts            # drafts | automated
daily_cap: 25
clump_size: 3                # automated mode: emails per hourly run
send_window: "10:00-18:00 local"
subject: "<city> <industry> startup reaching out to offer <thing>"
voice: |
  Earnest founder-to-professional. Feedback-first: say you're building for
  them, you're on this email 24/7, tell us what's missing and we'll build it.
  Sign as the founders. Plain human opt-out line. No hype, no clickbait,
  no URLs in the body, no promo codes unless verified to exist.
compliance_note: |
  You are responsible for the law where you and your recipients are:
  CAN-SPAM (US) requires identity, a physical mailing address, and honored
  opt-outs; GDPR/PECR (EU/UK) and CASL (Canada) are stricter about consent.
