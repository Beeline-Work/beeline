# ACP turn liveness

A Room or corner prompt has a 30-minute backstop. Every inbound ACP message
attributed to that session resets it, including thoughts, plans, tool updates,
permission requests, other agent requests, and responses to session requests.
Traffic for another session does not reset it.

A tool marked `pending` or `in_progress` suspends the backstop. Sparse updates
preserve its state. After every open tool reaches `completed` or `failed`, a
full backstop window starts. Tool execution owns its deadline, so a silent
40-minute release poll can finish normally.

If the backstop expires, the client sends `session/cancel` for that session and
rejects its prompt with `turn_backstop`, the elapsed silence in minutes, and
the last activity kind. It keeps the runtime and other sessions alive. Process
exit, stdout closure, or a closed/erroring stdin rejects pending requests with
`runtime_exited`. Pipe closure allows 25 ms for a concurrent exit to retain its
exit code and stderr. A SIGKILL OOM probe is bounded to 100 ms so diagnostics
cannot leave a dead runtime's requests hanging. Existing provider errors and
human cancellations retain their paths. The helper's distilled receipt text
already flows into the stalled card, so neither server nor mobile needs a new
reason enum.

The helper's functional update probe recognizes `turn_backstop` as the same
silent-prompt failure that triggers its existing fresh-session retry and
current-release comparison. That comparison still reads the old inactivity
wording from an older installed helper. A runtime exit remains distinct.
Reproduction ACP-L2 in `update-functional-probe.test.ts` covers this consumer;
the initial cause migration failed five of its integration cases.

Pi's repository-pinned `pi-ai` and `pi-coding-agent` version is 0.84.3. At that
version, `httpIdleTimeoutMs` configures Undici's HTTP header/body idle deadlines;
the SDK also passes it to providers that support explicit stream idle handling.
The generated isolated pi settings set it to 300000 ms and enable three
agent-level retries with a 2000 ms initial backoff. Pi classifies timeout and
terminated-stream errors as retryable. No total turn deadline is added.

The adapter installer uses `pi-acp@latest`, rather than a repository-pinned
adapter version. The inspected host adapter was 0.0.34: it launches `pi --mode
rpc`, inheriting `PI_CODING_AGENT_DIR`, so pi reads these generated settings.
Operator settings remain isolated. No pi package or adapter is patched.

Reproduction ACP-L1 is covered by `apps/body/src/acp-liveness.test.ts`. It
starts a real Node ACP subprocess, opens a release tool, advances the helper
clock through 40 minutes of silence, then completes the tool and observes the
answer. Before the fix it failed at 180000 ms. The same transport tests cover
process death, pipe closure, backstop cancellation, session isolation, and
every inbound message category. Clock advancement affects only the helper;
the protocol subprocess and pipes remain real.
