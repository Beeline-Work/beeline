# CLEANUP-GIT-1 reconciliation evidence

Production read at 2026-10-25 04:20 UTC: archived branch-bearing corners (1,421), missing branch-deletion jobs (1,158), completed deletion/missing-ref jobs (263), recorded retention reasons (0), pending jobs (0). These are global database counts, spanning multiple repositories.

PRs 2330, 2329 and 2327 were open although their corners had archived on October 11. Confirmed each branch was not the base of an open PR, closed each with `close_corner_pr` at its recorded corner address, then added the approved cleanup reason as a PR comment. No branch was deleted by this reconciliation.

A fresh GitHub open-PR listing matched against the archived Beeline branch records found remaining open archived-corner PRs (0). The throwaway CI drafts below remain separate because they have no corner records.

PRs 2673–2675 are open throwaway CI drafts. Database lookups found no corner recording these PRs or their `ci-measure/runners-*` branches. Their branches are not bases of open PRs. The requested corner-close route cannot address them; direct App PR closure needs commander clarification of that route requirement. No fabricated associations were written.

The Beeline repository has surviving archived branch refs (17). GitHub comparison against `main` found unpublished commits on (16); all must be retained under the approved one-time rule. The remaining branch still needs the worker's live protection, PR-use and active-corner checks. No new commits were pushed to preserve any old branch.

| Branch | Commits absent from main | Disposition |
| --- | ---: | --- |
| `feature/corner-045510c49fc5` | 7 | Keep: commits absent from main |
| `feature/corner-057d44a33743` | 1 | Keep: commits absent from main |
| `feature/corner-09265f05c180` | 4 | Keep: commits absent from main |
| `feature/corner-34accd409ecc` | 1 | Keep: commits absent from main |
| `feature/corner-40c81247778c` | 1 | Keep: commits absent from main |
| `feature/corner-43784bff4b6e` | 1 | Keep: commits absent from main |
| `feature/corner-53dff1cda1e9` | 0 | Pending remaining safety checks |
| `feature/corner-567c4e452359` | 1 | Keep: commits absent from main |
| `feature/corner-638001021597` | 2 | Keep: commits absent from main |
| `feature/corner-691d5dfa1039` | 1 | Keep: commits absent from main |
| `feature/corner-6d525f62420a` | 1 | Keep: commits absent from main |
| `feature/corner-a0a139db24c5` | 1 | Keep: commits absent from main |
| `feature/corner-ccd9c70dcffe` | 2 | Keep: commits absent from main |
| `feature/corner-ce114f41cc9d` | 12 | Keep: commits absent from main |
| `feature/corner-da560666070e` | 1 | Keep: commits absent from main |
| `feature/corner-e959305ff2f6` | 2 | Keep: commits absent from main |
| `feature/corner-fab4c1be9b5d` | 3 | Keep: commits absent from main |

Historical apply remains pending deployment of the guarded worker. The maintenance command in [the runbook](archived-corner-cleanup.md) deliberately does not enqueue history from a release migration, because an old worker could consume it during a rolling update. The release command has not been invoked. Counts here are baseline evidence, not a claim that the historical cleanup is finished.
