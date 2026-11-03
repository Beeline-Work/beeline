import {ROUTER_AUTHORITY_LOCK} from './router-projection-schema.js';

/** Owner data is independent of Workspace membership. Causes and revision
 * changes commit with the source, before any phone fanout observes them. */
export const ROUTER_OWNER_SCHEMA=`
CREATE TABLE IF NOT EXISTS owner_projection_cells(
 owner_id text NOT NULL REFERENCES identities(id) ON DELETE CASCADE,cell text NOT NULL,value jsonb NOT NULL,
 PRIMARY KEY(owner_id,cell)
);
CREATE TABLE IF NOT EXISTS owner_wallet_projections(
 owner_id text PRIMARY KEY REFERENCES identities(id) ON DELETE CASCADE,
 value jsonb NOT NULL, observed_at timestamptz NOT NULL DEFAULT now()
);
CREATE OR REPLACE FUNCTION beeline_owner_projection_source() RETURNS trigger AS $$
DECLARE current jsonb;previous jsonb;person text;family text;
BEGIN
 current:=CASE WHEN TG_OP<>'DELETE' THEN to_jsonb(NEW) ELSE '{}'::jsonb END;
 previous:=CASE WHEN TG_OP<>'INSERT' THEN to_jsonb(OLD) ELSE '{}'::jsonb END;
 IF TG_OP='UPDATE' AND current-'updated_at' IS NOT DISTINCT FROM previous-'updated_at' THEN RETURN NEW;END IF;
 IF TG_TABLE_NAME='identities' AND TG_OP='UPDATE' AND
  ROW(current->'name',current->'handle',current->'kind',current->'hidden_from_roster') IS NOT DISTINCT FROM
  ROW(previous->'name',previous->'handle',previous->'kind',previous->'hidden_from_roster') THEN RETURN NEW;END IF;
 IF TG_TABLE_NAME='agents' AND TG_OP='UPDATE' AND
  ROW(current->'owner_id',current->'machine_id',current->'machine_name',current->'squire_report',current->'squire_work') IS NOT DISTINCT FROM
  ROW(previous->'owner_id',previous->'machine_id',previous->'machine_name',previous->'squire_report',previous->'squire_work') THEN RETURN NEW;END IF;
 IF TG_TABLE_NAME='memberships' AND COALESCE(current->>'room_id',previous->>'room_id') IS NOT NULL OR
  TG_TABLE_NAME='live_outputs' AND COALESCE(current->>'kind',previous->>'kind')<>'presence' THEN
  IF TG_OP='DELETE' THEN RETURN OLD;END IF;RETURN NEW;END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('${ROUTER_AUTHORITY_LOCK}',0));
 IF TG_TABLE_NAME='wallet_bindings' THEN
  IF TG_OP='DELETE' THEN DELETE FROM owner_projection_cells WHERE owner_id=previous->>'identity_id' AND cell='wallet-summary';
  ELSE INSERT INTO owner_projection_cells(owner_id,cell,value) VALUES(current->>'identity_id','wallet-summary',
    jsonb_build_object('createdAt',extract(epoch FROM (current->>'created_at')::timestamptz),
      'expiresAt',extract(epoch FROM (current->>'delegation_expires_at')::timestamptz),
      'standing',(current->>'delegation_standing')::boolean))
    ON CONFLICT(owner_id,cell) DO UPDATE SET value=EXCLUDED.value WHERE owner_projection_cells.value IS DISTINCT FROM EXCLUDED.value;
  END IF;
 END IF;
 family:=CASE WHEN TG_TABLE_NAME IN('owner_wallet_projections','wallet_bindings') THEN 'owner-wallet' ELSE 'owner-workbench' END;
 FOR person IN SELECT DISTINCT value FROM (
  SELECT COALESCE(image->>'owner_identity_id',image->>'owner_id',image->>'identity_id') value
   FROM jsonb_array_elements(jsonb_build_array(previous,current)) image WHERE TG_TABLE_NAME<>'memberships'
  UNION SELECT agent.owner_id FROM agents agent WHERE TG_TABLE_NAME='identities' AND agent.agent_id=COALESCE(current->>'id',previous->>'id')
  UNION SELECT agent.owner_id FROM agents agent WHERE TG_TABLE_NAME='memberships' AND agent.agent_id=COALESCE(current->>'identity_id',previous->>'identity_id')
  UNION SELECT agent.owner_id FROM agents agent WHERE TG_TABLE_NAME='live_outputs' AND agent.agent_id=COALESCE(current->>'agent_id',previous->>'agent_id')
  UNION SELECT connector.owner_identity_id FROM workspace_connectors connector WHERE TG_TABLE_NAME='identities' AND connector.helper_agent_id=COALESCE(current->>'id',previous->>'id')
  UNION SELECT app.owner_identity_id FROM workspace_apps app WHERE TG_TABLE_NAME='workspaces' AND app.workspace_id::text=COALESCE(current->>'id',previous->>'id')
  UNION SELECT app.owner_identity_id FROM workspace_apps app JOIN workspace_app_usage usage ON usage.app_id=app.id
    WHERE TG_TABLE_NAME='identities' AND usage.agent_id=COALESCE(current->>'id',previous->>'id')
      OR TG_TABLE_NAME='rooms' AND usage.room_id::text=COALESCE(current->>'id',previous->>'id')
  UNION SELECT app.owner_identity_id FROM workspace_apps app WHERE TG_TABLE_NAME='workspace_app_usage' AND app.id::text=COALESCE(current->>'app_id',previous->>'app_id')
  UNION SELECT member.identity_id FROM rooms_mcp_connections member WHERE TG_TABLE_NAME='rooms_mcp_clients' AND member.client_id=COALESCE(current->>'id',previous->>'id')
  UNION SELECT COALESCE(current->>'id',previous->>'id') WHERE TG_TABLE_NAME='identities' AND
    (current->>'kind'='human' OR previous->>'kind'='human')
 ) audience WHERE value IS NOT NULL ORDER BY value LOOP
  INSERT INTO router_authority(scope) VALUES('owner:'||person||':owner-workbench'),('owner:'||person||':owner-wallet') ON CONFLICT DO NOTHING;
  INSERT INTO router_authority(scope) VALUES('owner:'||person||':'||family)
    ON CONFLICT(scope) DO UPDATE SET epoch=router_authority.epoch+1;
  PERFORM beeline_authority_hint(person,person,'owner:'||person||':'||family);
  PERFORM beeline_journal('owner:'||person,jsonb_build_object('sourceTable',TG_TABLE_NAME,'ownerFamily',family));
  IF TG_TABLE_NAME='identities' AND person=COALESCE(current->>'id',previous->>'id') AND
    (TG_OP<>'UPDATE' OR ROW(current->'kind',current->'hidden_from_roster') IS DISTINCT FROM ROW(previous->'kind',previous->'hidden_from_roster')) THEN
   INSERT INTO router_authority(scope) VALUES('owner:'||person||':owner-wallet') ON CONFLICT(scope) DO UPDATE SET epoch=router_authority.epoch+1;
   PERFORM beeline_authority_hint(person,person,'owner:'||person||':owner-wallet');
   PERFORM beeline_journal('owner:'||person,jsonb_build_object('sourceTable',TG_TABLE_NAME,'ownerFamily','owner-wallet'));
  END IF;
  PERFORM beeline_notify_live_control(jsonb_build_object('table','router_source','operation',TG_OP,'roomId','',
   'journalStreams',jsonb_build_array('owner:'||person))::text);
 END LOOP;
 IF TG_OP='DELETE' THEN RETURN OLD;END IF;RETURN NEW;
END;$$ LANGUAGE plpgsql;
DO $$ DECLARE table_name text;BEGIN
 FOREACH table_name IN ARRAY ARRAY['workspace_connectors','workspace_connections','workspace_apps','workspace_app_usage','agents',
  'identities','memberships','live_outputs','workspaces','rooms','link_oauth_accounts','rooms_mcp_connections','rooms_mcp_clients',
  'rooms_mcp_families','owner_wallet_projections','wallet_bindings','owner_projection_cells'] LOOP
  EXECUTE format('DROP TRIGGER IF EXISTS beeline_owner_projection_source ON %I',table_name);
  EXECUTE format('CREATE TRIGGER beeline_owner_projection_source BEFORE INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION beeline_owner_projection_source()',table_name);
 END LOOP;
END $$;
INSERT INTO owner_projection_cells(owner_id,cell,value) SELECT identity_id,'wallet-summary',
 jsonb_build_object('createdAt',extract(epoch FROM created_at),'expiresAt',extract(epoch FROM delegation_expires_at),'standing',delegation_standing)
 FROM wallet_bindings ON CONFLICT DO NOTHING;
INSERT INTO router_authority(scope) SELECT 'owner:'||id||':'||family FROM identities
 CROSS JOIN unnest(ARRAY['owner-workbench','owner-wallet']) family WHERE kind='human' ON CONFLICT DO NOTHING;
SELECT beeline_journal('owner:'||id,jsonb_build_object('sourceTable','owner-source-ready','ownerFamily','owner-workbench'))
 FROM identities WHERE kind='human' AND NOT EXISTS(SELECT 1 FROM live_streams WHERE id='owner:'||identities.id);
`;
