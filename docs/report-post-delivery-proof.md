# Reports and explicit reply delivery

Reproductions `RETURN-ADDRESS`, `POST-ID`, and `REPLY-ONCE` cover the approved
November 2 feedback cohort. Evidence was read through the owner's vaulted Neon
HTTP route on November 3; no production writes or agent wakes were made.

## Recorded evidence

- `fb_135f018e55318ee2d8065593` and `fb_1fc90832eefc4d72646b13f7` report
  `409: this order has no commander return address`. Both reporting commands
  are private report wakes in the parent Room. Their report parent points to
  a now-absent original command. The retained root message is still the human's
  explicit instruction to run daily triage, in that same Room. Inferring the
  recipient from the delegate's report would incorrectly reverse the chain.
- `fb_acbdbd38561a9429839bfdd1` and `fb_01abce6877c2b6362a32655b` describe
  different text posted with the same `replyTo` returning the earlier post's
  ID. The server used one mention ID for every explicit answer to that mention.
- `fb_932a228bf684926b6bfe6743` describes three deliveries of a human DM reply
  under different IDs. The production transcript has the first human reply
  and three distinct agent answers. The later two reported human message IDs
  are absent, including an indexed ID-range lookup and an exact-ID lookup.
  This does not establish whether the cause was transport, client resend, or
  wake replay. A same-ID phone retry already passes on main. No fix for an
  unproven different-ID retry mechanism is claimed.

## Reproduced

`commander.integration.test.ts` exercises actual daemon reports, command pickup,
phone sends and phone transcript reads against isolated PostgreSQL-compatible
PGlite. The baseline failed `RETURN-ADDRESS` after removing the report parent's
original incoming command, with the exact recorded refusal. `POST-ID` failed
because different text returned the same receipt. The no-explicit-return-address
agent order already reached its commander on main; its regression is retained.
`REPLY-ONCE` already passed for three submissions of one phone reply ID.

Production writes would wake real agents. The built HTTP service with an isolated
database is the closest stand-in, using the same paths and phone read projection.

## Demonstrated

Build the server and run:

```sh
node --import tsx scripts/prove-report-post-delivery.mjs
```

The script submits explicit threaded posts through authenticated built daemon
HTTP operations and checks that both texts appear once in the phone transcript
with different receipt IDs; retrying identical text returns its existing ID.
It submits a direct human reply three times with a stable ID and checks one
visible reply and one recipient command. It removes the explicit return address
from an agent order, reports, and claims the report as commander. After deleting
the original incoming command, escalation reaches the recorded human once.

Recovery reads only the recorded root human message, within the execution's
Workspace, when a report lacks its ordinary route. Deleted messages, System
facts and agent prose do not become human orders. Normal recipient membership
checks remain in place. Explicit reply deduplication includes public text;
automatic final replies and external MCP mention reply keys keep their existing
semantics. No migration or new idempotency-key API is introduced.

Focused regression command:

```sh
npm test -w @beeline/server -- src/commander.integration.test.ts -t 'Reproduction (RETURN-ADDRESS|POST-ID|REPLY-ONCE)'
```
