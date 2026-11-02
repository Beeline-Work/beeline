# Automatic prompt PR replay

Beeline's existing signed GitHub webhook automatically dispatches replay on
`pull_request` opened, synchronize and reopened events for
`Beeline-Work/beeline`. `apps/server/src/prompt-replay.ts` reads the PR's changed
file names through the installed GitHub App and matches the prompt-case inputs
from `.github/workflows/prompt-cases.yml`. Renamed and deleted inputs count.
File lists are paginated; GitHub's 3,000-file cap triggers replay conservatively.
Unrelated changes do not wake a model. The live head is checked around the file
read so a superseded event cannot dispatch the wrong head.

The server selects a current member of a repository-linked Room: Baby first,
then Terra, then Speedy, using the existing Room agent health policy. If all
members are offline, it queues the order for the first available member of
that roster to consume on reconnect. Each repository/PR/head has one durable
command ID across Rooms and agents, so webhook retries do not duplicate work.
This uses the existing private order queue, membership checks and delivery
path; no manual subscription, new endpoint, table, model API key, GitHub secret,
Actions runner or polling loop is needed. No Room test messages are posted.

The private order tells the agent to finish today, open its own replay-only
repository corner (`repositoryWork:false`), fetch the exact PR head, read the
controller and prepare dependencies. In that isolated corner:

```sh
npm run corner:prepare -- --build
node --import tsx scripts/prompt-pr-replay.mjs \
  --repository Beeline-Work/beeline --number <number> --head <40-character-sha> \
  --agent baby --out .beeline-proof/prompt-pr-replay
```

`--agent` selects the existing subscription model: `baby` → `gpt-6-luna`,
`terra` → `gpt-5.6-terra`, `speedy` → `gpt-6.1-sol`. Do not run this controller
from another agent's home. It reuses the subscription runner's fresh Codex
sessions, forced ChatGPT login, removed API-key environment, canned replay MCP
and disabled native tools. Each eligible case gets one independent sample.
The existing nightly browser-session exclusion remains explicit in the table.
An incomplete sample or a case failure fails the verdict. Subscription failures
mark remaining cases failed instead of silently omitting them. Local JSON,
traces and `verdict.md` remain in the corner's proof directory. The controller
uses `gh-axi` to check the live head before running and immediately before
posting; a superseded head gets no current verdict. Its comment includes the
exact head, model, agent and every case's result. A preparation or access
failure must produce an explicit FAIL on that head and a private report.

The ordinary `PROMPT CASES` check still validates the library without model
calls. `scripts/prompt-blocks-analysis.mjs` analyzes the private prompt-block
archive as aggregate data; it is not replay evidence. Never publish raw archive
prompts as proof. This PR replay does not replace the separate nightly tuning
experiment or its frozen tune/heldout partitions.

Local proof: `node --import tsx scripts/prove-prompt-pr-replay.mjs` after building
the server exercises a signed fake webhook, a private local agent command and
claim, the replay controller and PR comment publication. Its model/provider
and GitHub responses are test doubles; it makes no live model or GitHub writes.
The live agent subscription and real PR verdict must be verified after release.
A queued order alone is not evidence that a live replay ran.
