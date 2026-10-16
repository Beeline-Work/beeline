# Beebee first-reply timeline

`infra/free-agent/timeline-proof.mjs` measures the real mention-to-reply path on
Fly with three fresh Workspaces. Each sample covers first boot with no Machine,
then a mention immediately after the Machine reaches suspended. The helper,
Pi/ACP and model are real. A disposable local server/database and Cloudflare
quick tunnel isolate the proof from production. Squire egress adds network
hops to both the Fly API and model path; report that qualification with results.

Build the server and the exact-head free-agent image first. Publish a unique
test image tag; never replace `latest`. The runner requires `PROOF_IMAGE`.
`PROOF_FLY_APP` defaults to `beeline-free-agents`; its credential must permit
Machines in that app. `PROOF_SERVER_ENTRYPOINT` selects another built server
for a baseline checkout and otherwise uses `apps/server/dist/index.js`.

The runner reads one JSON object from stdin containing `machines` and `model`.
Each contains the backend-only `base_url` and `token` of a temporary Squire
egress grant. The first grant targets `api.machines.dev`, the second
`openrouter.ai`. Deliver these directly through stdin; do not save them in the
repository, include them in command arguments, or post them with artifacts.
After running, revoke both grants through Squire.

The output contains per-sample UTC marks, ten cumulative milestone offsets,
interval medians and observation counts. `results.json`, `summary.json`,
`marks.json` and private helper/service logs are written under the announced
`.scratch/beeline-timeline-*` directory. A null observation means absent or
retained, never a zero-duration measurement. A resumed Pi session may already
be ready, and a briefly suspended helper may retain its original connection.
Fly's started event may precede the start API response; those observations
overlap and must not be summed as sequential durations. Server connection
bookkeeping and command claim can also complete in either order.

The proof records the provisioning claim as the first-boot wake request and
`wake_requested` on resume. Guest session readiness comes from the helper's
`model-selection` startup mark. The model bridge records upstream request send
and first response-body byte; this is not necessarily the first visible text
token. Reply time comes from the committed message row. Clock comparisons
across the host, Fly and guest are diagnostic wall-clock offsets; the helper's
own startup durations remain monotonic.

Cleanup uses each run's unique Machine name to adopt an interrupted create,
destroys all test Machines, deletes its Workspaces and stops its tunnel/server
and database. A failed cleanup names the remaining resource and fails the run.
Check the final Fly list before reporting completion. Test images on a
temporary registry expire according to their tag's lifetime.

## Regression and comparison

Reproduction `beebee-suspend-start-412`: a mention immediately after Fly reports
suspended can race the snapshot transition. Fly refuses start with HTTP 412.
The previous wake path could retain a live connection and suppress another
start until heartbeat recovery, adding roughly a minute. `FlyMachines.start`
now retries only HTTP 412, at most five times, with 5.75 seconds of total
backoff. Other errors retain their normal handling.

Managed Pi free agents apply their server-pinned model through the live Room
session setter before prompting. They avoid a separate daemon-start ACP
preflight session. Model catalog publication, the normal helper's preflight,
minimum-version checks, release refresh and resume socket replacement retain
their existing paths. The real-session refusal regression verifies that a
refused managed model cannot send a prompt.

Use helper and server builds from the same baseline commit, then repeat all
six samples on the final head. Record source SHAs, image digests, sample IDs,
before/after medians and cleanup in the PR and Room artifacts. Cached images
from older tool contracts are diagnostic runs, not a controlled baseline.
