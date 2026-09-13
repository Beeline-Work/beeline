# Waiting-only brass proof

These captures use the real Expo web app at 390×844, signed in as the local
development identity against a locally migrated `@beeline/server`. The data is
the unchanged [`corner-states-four`](../corner-states-four/seed.sql) seed from
PR #1169.

- `room-list-390x844.png` demonstrates that only `waiting` is brass; `working`
  and `review` use the quiet gray tier, while `archived` uses the ghost tier.
- `header-waiting-390x844.png` demonstrates the brass waiting subtitle with its
  existing failure suffix treatment.
- `header-working-390x844.png` demonstrates the quiet working subtitle.

The original `corner-states-four/room-list-390x844.png` is the reproduced
before state: working and review are brass while waiting is quiet.
