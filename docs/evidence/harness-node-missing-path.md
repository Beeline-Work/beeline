# Own-agent interpreter startup

Reproduction `harness-node-missing-path`: a daemon ACP child starts an absolute
`#!/usr/bin/env node` harness with a PATH that cannot find Node. On unchanged
main (`373b93a48`), both the direct executable and npm-style symlink cases fail
with exit 127 / `env: node: No such file or directory` (sometimes surfaced first
as stdin EPIPE). With the fix they initialize and open an ACP session.

The hermetic test uses an empty search directory because squire already has
`/usr/bin/node`: `/usr/bin:/bin` alone cannot reproduce macOS's missing Node
here. The real macOS launchd reproduction was unavailable on this Linux host.
The test also covers a wrapper executable and both env-based and absolute
missing shebang interpreters. EPIPE during initialization now retains the
interpreter's stderr rather than losing the actionable cause.

## Installed harness proof

Installed `@agentclientprotocol/codex-acp@2.2.2` into the existing nvm Node
v24.16.0 installation on squire, without package lifecycle scripts, then ran:

```sh
env PATH=/usr/bin:/bin /home/lunchbox/.nvm/versions/node/v24.16.0/bin/node \
  scripts/prove-harness-node-path.mjs \
  /home/lunchbox/.nvm/versions/node/v24.16.0/bin/codex-acp
```

The built daemon's `AcpClient` initialized the installed adapter. Linux
`/proc/<pid>/exe` confirmed its interpreter was
`/home/lunchbox/.nvm/versions/node/v24.16.0/bin/node`.
The proof isolates HOME and XDG directories and never starts, pairs, or
reconfigures the live machine helper. It proves the daemon's actual subprocess
startup component, rather than a full service restart or a model answer.

## Room failure proof

The server integration sends a failed daemon receipt through
`DaemonService.execute('postAgentTurnReceipt')` and checks the committed Room
failure row. It names the missing Node dependency and `beeline connect`, without
the raw runtime error. The browser proof renders that failure vocabulary through
the actual `LedgerSystemLine` component in Chrome at 320px, expands the row, and
checks the dependency and recovery command are present.

Production was opened read-only at `web.usebeeline.app` through Squire. It was
already signed in as the owner, not the GitHub reviewer. The connected reviewer
bypass was confirmed, but a reviewer login and production rendering of this
unreleased server change were not obtained. The Chrome component proof and
server receipt proof are the explicit stand-ins; neither is a production
end-to-end claim. No release was dispatched.

## Environment and recovery choices

The child PATH order is the resolved executable's real directory, then the
original invoked directory (npm links point into `node_modules`, whereas nvm's
Node lives next to the link), followed by the existing PATH. Already present
entries retain their positions and are not duplicated. An absent PATH retains
POSIX's implicit `/usr/bin:/bin` fallback. Relative commands remain unchanged.
Only those harness directories are added; no shell profile or unrelated version
manager directories are imported. Room/corner wrappers pass the actual selected
harness path separately. Hosted free-agent environments skip this adjustment.

There is no `beeline doctor` command. The connect wizard performs a live ACP
startup/model probe, but inherits the interactive caller's environment; it is
not an audit of the daemon environment. The message therefore asks the user to
install the required interpreter and run the existing `beeline connect` command
on that computer to reinstall/reselect the agent, rather than promising a
nonexistent diagnostic. Full errors remain available to the existing daemon
log/Sentry path; only the receipt and Room prose are distilled.

PATH joins use the native delimiter and preserve Windows' existing Path key.
Windows `.cmd` execution/shim behavior is out of scope and was not tested; this
does not add a shell or claim new Windows shim support.
