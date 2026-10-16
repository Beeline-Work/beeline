import { REVIEW_IDENTITY_ID } from './review-access.js';

// Confirmed operator fixtures. Use immutable IDs rather than guessing from a
// customer's Workspace name. Mixed memberships retain the real person.
const FIXTURE_WORKSPACE_IDS = [
  'bee11e00-0000-4000-8000-000000000105', // Play Review
  'c2e54c45-cf58-4cc1-a620-89b196096e7b', // Firstmate Proof
  'b81a2815-924c-4bd9-bc04-d38bdee177bc', // Empty screen test
];
const FIXTURE_IDS_SQL = FIXTURE_WORKSPACE_IDS.map((id) => `'${id}'`).join(',');
export const COHORT_SQL = `production_workspaces AS (
  SELECT id FROM workspaces WHERE id NOT IN (${FIXTURE_IDS_SQL})
), production_identities AS (
  SELECT i.id FROM identities i WHERE NOT i.hidden_from_roster
    AND i.id <> '${REVIEW_IDENTITY_ID}'
    AND (NOT EXISTS (SELECT 1 FROM memberships m WHERE m.identity_id=i.id AND m.room_id IS NULL)
      OR EXISTS (SELECT 1 FROM memberships m JOIN production_workspaces w ON w.id=m.workspace_id
        WHERE m.identity_id=i.id AND m.room_id IS NULL))
)`;
