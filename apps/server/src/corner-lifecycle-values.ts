import { Applied } from './corner-lifecycle-review-state.js';



export const CORNER_LIFECYCLE_SLUG = 'corner';

export const OK: Applied = { ok: true };


/** Expand only: old lifecycle cards remain inert for the previous image. */
export const CORNER_MACHINE_SCHEMA = `
ALTER TABLE corner_facts ADD COLUMN IF NOT EXISTS machine jsonb;
`;


// Compare check results, not refresh timestamps, attempts or run URLs.
export const reviewChecksSql = `jsonb_build_object('status',lifecycle->>'checks','checks',
  (SELECT jsonb_agg(jsonb_build_object('name',item->>'name','status',item->>'status') ORDER BY item->>'name')
   FROM jsonb_array_elements(COALESCE(lifecycle->'checksSummary'->'checks','[]'::jsonb)) item))`;


export const REVIEWER_NOT_PARENT_MEMBER = 'not a current member of the parent Room';

export const REVIEWER_NOT_CORNER_MEMBER = 'not a current member of this corner';
