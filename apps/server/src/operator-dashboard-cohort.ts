import { REVIEW_IDENTITY_ID } from './review-access.js';

export const COHORT_SQL = `production_workspaces AS (
  SELECT id FROM workspaces WHERE NOT internal
), production_identities AS (
  SELECT i.id FROM identities i WHERE NOT i.hidden_from_roster
    AND i.id <> '${REVIEW_IDENTITY_ID}'
    AND (NOT EXISTS (SELECT 1 FROM memberships m WHERE m.identity_id=i.id AND m.room_id IS NULL)
      OR EXISTS (SELECT 1 FROM memberships m JOIN production_workspaces w ON w.id=m.workspace_id
        WHERE m.identity_id=i.id AND m.room_id IS NULL))
)`;
