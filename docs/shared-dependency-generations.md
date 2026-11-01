# Shared dependency generations

Sandboxed repository corners prepare root npm dependencies before harness activation. Mobile remains opt-in: `npm run corner:prepare -- --mobile` requests its tree on the next turn. Both use one machine store, keyed by the lockfile, Node ABI, architecture and platform. Workspace corners use the same path.

Each checkout keeps writable npm metadata and tool caches, plus its own directory structure and workspace symlinks; package files share store inodes. The helper seals installed package directories with read-only binds after writable checkout and agent-home mounts. A corner cannot chmod or write those files through its mount namespace. This is the existing sandbox's filesystem boundary, not protection against privileged host services that bypass the namespace.

Use `npm install --package-lock-only --ignore-scripts <package>` to change a dependency. Direct mutating npm commands receive a diagnostic naming this path. The next turn compares dependency fingerprints, stops the old session, prepares the new generation, and starts a session with new mounts. Other corners keep their existing generation. `corner:prepare` preserves managed mounts rather than running `npm ci` over them.

Preparation removes old shared aliases before running installation scripts privately. Only store publication, hardlink placement and collection are serialized; a hung install cannot hold another corner behind the store lock. A complete tree is published and linked back into the first checkout too. Package install scripts run in the corner’s sandbox before the tree is sealed, with the same credential masks and writable paths as its harness. No shared tree is exposed by checkout materialization alone. A checkout with managed dependencies requires bubblewrap to resume.

Collection removes generations whose files have no remaining checkout hardlinks. It runs during preparation and after checkout reclamation. Active checkout references protect generations regardless of age; the store no longer evicts active generations merely because more lockfiles exist. The existing checkout deletion authority remains unchanged.

## Demonstration

This is a dependency-sharing feature, not a defect report. `DEPENDENCY-GENERATION-1` uses real local npm tarballs, the built helper's generation functions, and its actual sandbox command construction:

```
npm run build -w @beeline/body
node scripts/prove-shared-dependencies.mjs
```

The proof creates two consumers, proves matching package inodes, attempts chmod/write through the sandbox, checks the direct-install diagnostic, updates one consumer's lockfile inside the sandbox, prepares the next generation, and builds both consumers. The outputs remain `2.0.0` and `1.0.0`. It then removes each checkout's dependencies and proves reference-based collection preserves the remaining consumer and eventually collects both generations. All temporary fixtures are removed.

The fixture payload is 23 bytes: a shared Codex reference uses 23 bytes, two private Beeline installs use 46 bytes, and the shared Beeline payload uses 23 bytes. These are payload-only fixture measurements, not a full-helper memory or fleet disk parity result. Directory and npm metadata remain per checkout.

## Extra copies

From the primary corner, register each disposable copy with `npm run corner:prepare -- --extra <path>`. This records a request without installing anything. At the next turn the helper validates the copy belongs to this corner or its agent home, prepares it through the same lockfile-keyed store, and seals its dependency directories before launching the harness. Registration and subsequent lockfile edits replace retained sessions. Deleted rigs stop pinning generations when their dependency hardlinks disappear.

This covers `.verification`, `.scratch`, Claude worktrees and agent-home rigs. Keep temporary rigs under the corner or its agent home: the harness's private `/tmp` disappears with its namespace and cannot be prepared by the helper. Run the registration command from the primary corner even when the copy contains its own preparation script. The existing npm guard prevents private installation in managed sessions. This feature requires a helper release containing this change; the registration command alone does not retrofit an older running helper.

The built-helper proof now registers five extra copies using the real preparation command, resolves requests through the helper, and supplies an installer that throws if any extra copy tries to install privately. Each copy shares the original package inode, denies writes through the sandbox and builds successfully. Fixture payload across the original two consumers plus five extras is 161 bytes before sharing and 23 bytes after sharing (the shared Codex reference is 23 bytes). This excludes per-copy metadata and process memory. It is not a full-helper parity claim.

Remaining fleet work: the shared main comparison checkout; cache/target consolidation; full-helper disk and memory measurements; memory, emulator, index and idle-session reductions; the separately authorized squire cleanup. This PR does not claim the overall fleet parity acceptance bar.
