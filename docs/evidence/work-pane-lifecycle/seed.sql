\set ON_ERROR_STOP on

BEGIN;

UPDATE identities
SET name = 'Moon Scanner', handle = 'captain', face_id = 'fox'
WHERE id = '913c42067daddb44ab84270088b65547077049070a3065c06bb6263c32e8aecb';

INSERT INTO identities(id, kind, name, handle, face_id) VALUES
  (repeat('a', 64), 'agent', 'Hoots', 'hoots', 'owl')
ON CONFLICT (id) DO UPDATE
SET name = EXCLUDED.name, handle = EXCLUDED.handle, face_id = EXCLUDED.face_id;

INSERT INTO agents(agent_id, owner_id, soul) VALUES
  (repeat('a', 64), '913c42067daddb44ab84270088b65547077049070a3065c06bb6263c32e8aecb', '{"name":"Hoots","instructions":"Careful repository helper"}')
ON CONFLICT (agent_id) DO NOTHING;

INSERT INTO workspaces(id, name, visibility) VALUES
  ('11111111-1111-4111-8111-111111111111', 'Tubing Crew', 'invite-only')
ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, visibility = EXCLUDED.visibility;

INSERT INTO rooms(id, workspace_id, created_by, name, repository_name, repository_resolution) VALUES
  ('33333333-3333-4333-8333-333333333333', '11111111-1111-4111-8111-111111111111', '913c42067daddb44ab84270088b65547077049070a3065c06bb6263c32e8aecb', 'beeline', 'Beeline-Work/beeline', 'none'),
  ('44444444-4444-4444-8444-444444444444', '11111111-1111-4111-8111-111111111111', repeat('a', 64), 'Nav Resizer Fix', NULL, 'none'),
  ('55555555-5555-4555-8555-555555555555', '11111111-1111-4111-8111-111111111111', repeat('a', 64), 'Corner Focus Mode', NULL, 'none')
ON CONFLICT (id) DO NOTHING;

UPDATE rooms SET parent_id = '33333333-3333-4333-8333-333333333333'
WHERE id IN ('44444444-4444-4444-8444-444444444444', '55555555-5555-4555-8555-555555555555');

INSERT INTO memberships(workspace_id, room_id, identity_id, role) VALUES
  ('11111111-1111-4111-8111-111111111111', NULL, '913c42067daddb44ab84270088b65547077049070a3065c06bb6263c32e8aecb', 'owner'),
  ('11111111-1111-4111-8111-111111111111', NULL, repeat('a', 64), 'member'),
  ('11111111-1111-4111-8111-111111111111', '33333333-3333-4333-8333-333333333333', '913c42067daddb44ab84270088b65547077049070a3065c06bb6263c32e8aecb', 'owner'),
  ('11111111-1111-4111-8111-111111111111', '33333333-3333-4333-8333-333333333333', repeat('a', 64), 'member'),
  ('11111111-1111-4111-8111-111111111111', '44444444-4444-4444-8444-444444444444', '913c42067daddb44ab84270088b65547077049070a3065c06bb6263c32e8aecb', 'owner'),
  ('11111111-1111-4111-8111-111111111111', '44444444-4444-4444-8444-444444444444', repeat('a', 64), 'member'),
  ('11111111-1111-4111-8111-111111111111', '55555555-5555-4555-8555-555555555555', '913c42067daddb44ab84270088b65547077049070a3065c06bb6263c32e8aecb', 'owner'),
  ('11111111-1111-4111-8111-111111111111', '55555555-5555-4555-8555-555555555555', repeat('a', 64), 'member')
ON CONFLICT DO NOTHING;

INSERT INTO corner_facts(corner_id, owner_agent_id, commissioned_by, objective, lifecycle, request_id) VALUES
  ('44444444-4444-4444-8444-444444444444', repeat('a', 64), '913c42067daddb44ab84270088b65547077049070a3065c06bb6263c32e8aecb', 'Reproduce the stuck desktop sidebar resize handle live, fix the drag, and add test coverage.', '{"lifecycle":"working","checks":"pending"}', 'nav-resizer-request'),
  ('55555555-5555-4555-8555-555555555555', repeat('a', 64), '913c42067daddb44ab84270088b65547077049070a3065c06bb6263c32e8aecb', 'Replace maximize with one predictable corner placement lifecycle.', '{"lifecycle":"working","checks":"unknown"}', 'corner-focus-request')
ON CONFLICT (corner_id) DO UPDATE SET objective = EXCLUDED.objective, lifecycle = EXCLUDED.lifecycle;

INSERT INTO agent_turns(room_id, request_id, agent_id, status, started_at) VALUES
  ('44444444-4444-4444-8444-444444444444', 'nav-resizer-request', repeat('a', 64), 'working', now() - interval '8 minutes')
ON CONFLICT (room_id, request_id, agent_id) DO UPDATE SET status = 'working', started_at = EXCLUDED.started_at;

INSERT INTO messages(id, room_id, author_id, text, presentation, card_type, card, created_at) VALUES
  (repeat('1', 64), '33333333-3333-4333-8333-333333333333', repeat('a', 64), 'The pull request is open. @captain please review', 'message', NULL, NULL, now() - interval '12 minutes'),
  (repeat('2', 64), '33333333-3333-4333-8333-333333333333', repeat('a', 64), '', 'card', 'daemon-fact', '{"type":"corner-open","cornerId":"44444444-4444-4444-8444-444444444444","name":"Nav Resizer Fix","objective":"Reproduce the stuck desktop sidebar resize handle live, fix the drag, and add test coverage."}', now() - interval '10 minutes'),
  (repeat('3', 64), '33333333-3333-4333-8333-333333333333', repeat('a', 64), '', 'card', 'daemon-fact', '{"type":"corner-open","cornerId":"55555555-5555-4555-8555-555555555555","name":"Corner Focus Mode","objective":"Replace maximize with one predictable corner placement lifecycle."}', now() - interval '9 minutes'),
  (repeat('4', 64), '44444444-4444-4444-8444-444444444444', repeat('a', 64), 'Root cause found. Now producing the demonstration at this head.', 'message', NULL, NULL, now() - interval '4 minutes')
ON CONFLICT (id) DO NOTHING;

COMMIT;
