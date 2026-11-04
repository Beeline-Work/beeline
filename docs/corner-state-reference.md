# Corner state reference

Accepted audit decisions G3 replace declaration hashes with behavior. Review
changes to this reference weekly after merging, alongside the System catalog.
`corner-state-reference.test.ts` exhausts the cross product below; database
projection coverage remains in `corner-person-state.test.ts` and
`corner-person-state.production.test.ts`.

First matching rule wins:

1. An actually archived corner is archived. On an unlocked corner, a closed or
   landed run, a done/abandoned lifecycle, or a confirmed merge also archives it.
   Locking suppresses inferred endings, never actual archival.
2. A running implementer is working, even with pending checks or a blocker.
3. A running reviewer, pending CI, an individual pending job, or a pushed head
   whose empty unknown summary has never been fetched is review. A fetched empty
   summary means no configured checks and does not establish activity.
4. An unresolved blocker is waiting; retain its reason and reference.
5. Otherwise the corner is idle. Passing/failing checks and workflow stages
   alone do not imply a running agent.

The exhaustive dimensions are archival, locking, six ending sources, worker
activity, reviewer activity, seven CI observations and blocker presence.
