# Durable corner assignments

`open_corner` accepts an optional full `brief` beside its short name and objective. A brief contains up to 65,536 characters of requirements and up to 16 Room files. Each file entry names a server object ID, purpose, and required status. The server resolves filename, MIME type, size, and SHA-256 from a ready object referenced by a message from its owner in the source Room. A missing or inaccessible file rejects the open. The corner Room, revision 1, initial worker command, and open card commit together; retries with the same tool-call key return that corner.

`revise_corner_brief` supplies the complete replacement, expected revision, and a change description. Revisions are immutable rows with author and source-message provenance. The opener's revision and the resulting worker command commit together. A green corner also wakes its configured reviewer. `read_corner_brief` pages previous revisions. Existing corners without a brief keep their objective and transcript path.

Every worker turn reads the current revision from the server, downloads its files into the session scratch, and compares downloaded SHA-256 with the manifest. A missing or changed required file is called out in the prompt so dependent work pauses. Open corners pin referenced objects against the media sweep; the sweep and assignment validation lock the same object row. Closing a corner releases the pin and normal expiry resumes.

The configured reviewer sees the same current revision. `approve_merge` includes that revision; the server checks it and the PR head under the corner lock. A revised assignment invalidates an earlier approval even when the code head is unchanged. The existing `pr_checks_status` gate remains the merge authority. Validation stage records are scoped to revision and PR head. Missing stages project as pending; a changed revision or head makes prior evidence inapplicable. Stage records do not authorize a merge.

The phone's corner header has an Assignment disclosure showing the current brief, file purposes, revision, and validation stages. Brief and validation reads degrade independently of the core Room read. Server deployment must precede the body version that calls the new operations.

## Acceptance evidence

| Criterion | Evidence | Status |
| --- | --- | --- |
| A1 | `monolith-corner-turn.test.ts` renders the assigned full brief outside the bounded transcript; `integration.test.ts` stores and restores it. | Verified at prompt and storage boundaries; no live Room trial. |
| A2 | `beeline-spec` and Room guidance allow a compact brief without a new approval step. | Behavioral agent trial pending. |
| A3 | The skill asks for one material unresolved choice and records the answer in a revision. | Behavioral agent trial pending. |
| A4 | `integration.test.ts` covers atomic open, idempotent retry, and missing-file rollback with no worker command. | Verified; synthetic database-failure injection not run. |
| A5 | Integration fixture retrieves server-owned bytes after the object has passed ordinary TTL while the corner is open. | Verified at object storage boundary; separate-helper trial pending. |
| A6 | Prompt test includes brief revision and a deliberate choice despite a long corner transcript. | Verified for fresh prompt construction; full restart trial pending. |
| A7 | Integration test keeps both revisions and requeues work; `pr-checks-status.test.ts` rejects approval for the old revision at an unchanged head. | Verified. |
| A8 | Review skill requires every criterion and rejects a narrow passing diff. | Permissions matrix review trial pending. |
| A9 | Review skill requires visual and server authorization evidence at their actual boundaries. | Independent reviewer trial pending. |
| A10 | Integration test refuses a nonmember's read and revision; writes retain command authority. | Verified for brief operations. |
| A11 | Phone `RoomView` projects the current brief; `CornerBriefDisclosure.test.tsx` opens content, evidence, and a file link. | Verified at API/component boundary; device proof pending. |
| A12 | Legacy startup, PR check gate, reviewer dispatch, and corner command suites pass. | Verified for those paths; content-equivalent catch-up needs separate proof. |
| A13 | Worker prompt test retains the deliberate amber-label requirement. | Verified in worker prompt; independent reviewer trial pending. |
| A14 | Nine validation stages project as pending until recorded. Integration test records evidence and rejects an empty passed claim. | Verified at record boundary; complete live pipeline pending. |
| A15 | Existing review handback tests cover bounded author wake and repair; revision gate invalidates stale evidence. | Full refusal, repair, and rereview trial pending. |
| A16 | Review procedure sends mechanical findings to the author and asks a human only for unresolved product choices. | Behavioral agent trial pending. |
| A17 | `pr-checks-status.test.ts` keeps the composite merge gate; stage records do not merge or authorize. | Verified at server/helper boundary. |
| A18 | Integration test rejects false CI pass, empty evidence, and old head evidence; merge gate rejects old revision. | Verified at record and gate boundaries; unavailable-tool reporting trial pending. |

The installed `beeline-spec` skill is generated by `apps/body/src/beeline-skill.ts` and provisioned with the other release-managed agent skills. Its guidance does not grant command, file, or merge authority.
