# Isolated server CI runners on squire

The proposed permanent replacement is in [the socket-activated broker draft](../scripts/ci-runner-systemd/README.md). It is not installed; the earlier forked activation path is superseded for future rollout.

This rollout is incomplete. Keep `BEELINE_CI_SHARDS` unset until the host
proofs below pass and the owner has approved the public-fork policy change.
Do not execute the superseded persistent installer grant `a97ebc0f`.

Four dedicated users have separate minimal filesystem jails. Only public
system binaries and TLS certificates are bound into each jail. Agent homes,
production runner directories, host runtime sockets and the host Docker socket
are absent. Each user has only its own group. Each private Docker engine has
been observed responding in rootless mode. PostgreSQL readiness has been
demonstrated on the first engine; the other engines still need that proof.

The revised installer pins the runner archive checksum and the bytes of
`prepare-ephemeral-ci-runner.py` and `isolated-ci-entry.py`. It installs root-owned per-job preparation,
an output firewall matching the four UIDs, and resource slices limiting each
runner plus its engine together to twelve GiB and three CPUs. It does not start
or enable runners. The previous provisioning script is not rerun: its live
instances already have public alternatives symlinks and the proc-mask repair.

Before every ephemeral registration, root stops the private Docker service,
kills residual processes of that user, deletes all private state, extracts a
fresh runner, and starts a fresh Docker engine. This removes previous home,
work, runner files, images, containers and volumes. The preflight then requests
a new short-lived registration token and configures `--ephemeral`.
`Restart=always` repeats this process after each completed job. A missing
rootless environment marker makes installation stop before host changes.

The token relay runs as the owner using the corner's existing GitHub App
authorization. It accepts only root Unix-socket peers and checks that GitHub's
fork approval policy is `all_external_contributors` before every token issue.
The owner must change that policy; these scripts never change it. A relay or
GitHub authorization outage prevents registration. A durable relay and token
renewal path still need verification before this can be an unattended rollout;
an interactive corner process alone is not an availability proof.

Only explicitly enabled same-repository PRs and pushes to main select the
dedicated runner label. Other events use hosted runners. Existing workflow
triggers and job conditions are unchanged. The public-fork approval policy is
also required: an untrusted fork can edit its own workflow to request the
label, so the trusted workflow expression alone is insufficient protection.
Whoever approves a fork PR must read its workflow changes before approving
execution. Repository-level runners are used; organization runner-group
permissions are not required for this rollout. Keep the routing expression,
owner-controlled policy, and relay policy check together.

Runner.Listener enters its engine's rootlesskit user/network namespaces, so
job loopback is private. UID rules also drop host-local destinations, including
squire's public address. Configuration uses `--replace`, retains shard ownership
of extracted runner files, and receives registration authorization over stdin
rather than transient unit environment properties.

## Required live proof before activation

Use scoped host grants for all host operations:

- Confirm nftables counters cover every shard UID. A curl from each jail to
  squire's tailnet address must fail; a Docker Hub pull must succeed.
- From the actual runner namespace, curl to `127.0.0.1:11434`,
  `172.93.111.86:28090`, a tailnet host, and a LAN address must fail, while
  the private PostgreSQL service remains reachable.
- Run the PostgreSQL service image on every private engine and confirm readiness.
- Verify each combined slice's memory/CPU limits and inaccessible private paths.
- Across two jobs, leave markers in home/work/runner state and a Docker volume;
  prove all disappear before the next ephemeral registration, including residual
  processes. Confirm GitHub deregisters completed ephemeral runners.
- Measure four simultaneous shards while agents run. Drop to two runners if
  agent responsiveness suffers. Record queue and push-to-result times on at
  least three PRs, with shard duration no slower than the hosted baseline.

Activate only after these proofs. To revert routing to hosted immediately:

```sh
gh variable set BEELINE_CI_SHARDS --repo Beeline-Work/beeline --body disabled
```

This affects subsequent job scheduling; already queued jobs may require cancellation.
