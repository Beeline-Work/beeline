import { SERVICE_REVIEW_READ_SCHEMA } from './service-review.js';


export const DATABASE_SCHEMA_TABLES = `CREATE UNIQUE INDEX IF NOT EXISTS workspace_connections_machine_reference_unique
  ON workspace_connections(owner_identity_id,machine_id,reference) WHERE machine_id IS NOT NULL;
DELETE FROM workspace_connectors WHERE connector_type='trusty-squire';
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='workspace_connectors_no_squire') THEN
    ALTER TABLE workspace_connectors ADD CONSTRAINT workspace_connectors_no_squire
      CHECK (connector_type<>'trusty-squire');
  END IF;
END $$;

${SERVICE_REVIEW_READ_SCHEMA}
`;
