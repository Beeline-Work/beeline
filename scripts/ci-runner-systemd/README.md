# Permanent registration broker proposal (not installed)

This replaces the forked, corner-bound broker. No host changes, credentials,
GitHub App creation, grants or registration are authorized by this draft.
The successful four-user isolation proof and two reset cycles per selected
runner remain evidence; registration/load/three-PR timings remain outstanding.

## Exact permission and owner decision

Create a dedicated organization-owned GitHub App, installed on Beeline-Work,
with organization **Self-hosted runners: read and write** and repository
**Administration: read-only**, selecting **Beeline-Work/beeline only**.
GitHub also grants mandatory Metadata read. Request no repository contents,
Actions write, Administration write, personal token or personal gh access.

Organization Self-hosted runners write is required to mint organization
registration tokens and inspect runner groups. Administration read is required
to verify the repository fork approval policy before every issuance. GitHub
has no registration-only App permission: Self-hosted runners write also permits
other runner-management operations. The dedicated service exposes only token
issuance to root peers; that is a local restriction, not a narrower GitHub key.
This residual permission breadth requires the owner's decision.

Sources: [organization registration permissions](https://docs.github.com/en/rest/actions/self-hosted-runners#create-a-registration-token-for-an-organization),
[policy read permissions](https://docs.github.com/en/rest/actions/permissions#get-fork-pr-contributor-approval-permissions-for-a-repository).

An org administrator must create runner group **beeline-server-ci**, selected
repository access only to Beeline-Work/beeline, with public repository access
explicitly enabled because this repository is public. No other repository can
use this group. Broker checks its name, selected visibility, public access and
exact repository list before each issuance. Registration uses the org URL and
`--runnergroup beeline-server-ci`, with the existing dedicated label and
`--ephemeral`. Do not register into the default group.

## Credential custody and boot behavior

The owner provisions the dedicated App private key directly through secure host
administration, encrypted for squire using systemd credentials. Store the encrypted
blob in `/etc/credstore.encrypted/beeline-ci-app-key`, root-owned mode 0600;
keep the directory root-only. The private key never enters the repository,
chat, agent environment, command arguments or runner jail. The service alone
loads it with `LoadCredentialEncrypted`; signing uses an anonymous memfd and
OpenSSL. JWTs, installation access tokens and registration tokens stay in memory.
The service has no personal gh or corner wrapper dependency.

Non-secret root-owned `/etc/beeline-ci-registration.conf` contains
`GITHUB_APP_ID`, `GITHUB_INSTALLATION_ID`, `GITHUB_RUNNER_GROUP_ID` after the
owner supplies those identifiers. The example unit deliberately contains no
invented IDs. Rotate/revoke the dedicated App key through the owner; restart
only this broker service afterward. Reboot unsealing must be tested on this
host before accepting durability.

Install `broker.py` root-owned mode 0700 at
`/usr/local/lib/beeline-ci/broker.py` and the two supplied unit files under
`/etc/systemd/system`. Install `prepare.py` root-owned mode 0600 at the existing
`/usr/local/lib/beeline-ci/prepare.py` location; it retains the installed reset
and readiness logic, changes registration to the organization/group and allows
180 seconds for the broker's bounded API requests. It replaces, rather than
layers on, the earlier repository-registration helper. Pin its digest in the
future reviewed installer; no old activation launcher should be rerun.

Install `runner-registration.conf` as a drop-in for runners one and two. Enable
the socket at boot and the selected runner units only after owner-approved
installation. Systemd owns the socket across broker crashes and activates the
root service on demand. Runner preparation can connect immediately and waits
for authorization; network/API failure returns no token and fails closed.

The socket unit's cleanup command attempts a real connection to any existing
socket. Only ECONNREFUSED permits removal. A live listener, symlink/non-socket,
permission failure or timeout prevents unlinking. Stop any old broker first;
never remove a socket merely because a PID lookup found nothing. This handles
the reported stale socket without an unconditional rm. The parent becomes
root-owned mode 0700 and the socket root-only 0600, outside all runner jails.

All broker output goes to the journal. Errors record HTTP status or exception
type, never exception bodies, API response bodies, credentials or tokens.
Every policy check, success or failure, logs `policy_seconds` measured by a
monotonic clock. No policy timing is claimed before a real deployment run.
The server socket is inherited as systemd fd 3, so policy latency cannot race
creation of the listener. No fork, readiness polling or /dev/null redirection.

## Review and rollout proof

Local tests cover active/stale socket behavior, policy and group rejection,
registration ordering and token-free errors. These are design validation only.
After approval: verify systemd units against the installed systemd version,
install through a new explicitly approved host action, then measure actual
policy latency and simulate broker restart with the socket continuously open.
Demonstrate registration after corner closure and controlled host reboot before
calling this durable. Check exact token values against journals/runner logs;
repeat a real ephemeral job and prove fresh state and registration afterward.
Then collect concurrent load and queue/result timings on three PRs. Keep
routing hosted until these proofs pass. No merge approval is implied.
