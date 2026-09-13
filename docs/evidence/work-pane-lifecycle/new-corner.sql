\set ON_ERROR_STOP on

BEGIN;
INSERT INTO rooms(id, workspace_id, parent_id, created_by, name, repository_resolution)
VALUES ('88888888-8888-4888-8888-888888888888', '11111111-1111-4111-8111-111111111111', '33333333-3333-4333-8333-333333333333', repeat('a', 64), 'Live Auto-selected Corner', 'none')
ON CONFLICT (id) DO NOTHING;
INSERT INTO memberships(workspace_id, room_id, identity_id, role) VALUES
  ('11111111-1111-4111-8111-111111111111', '88888888-8888-4888-8888-888888888888', '913c42067daddb44ab84270088b65547077049070a3065c06bb6263c32e8aecb', 'owner'),
  ('11111111-1111-4111-8111-111111111111', '88888888-8888-4888-8888-888888888888', repeat('a', 64), 'member')
ON CONFLICT DO NOTHING;
INSERT INTO corner_facts(corner_id, owner_agent_id, commissioned_by, objective, lifecycle, request_id)
VALUES ('88888888-8888-4888-8888-888888888888', repeat('a', 64), '913c42067daddb44ab84270088b65547077049070a3065c06bb6263c32e8aecb', 'Prove that a newly opened corner selects itself into a present work pane.', '{"lifecycle":"working","checks":"unknown"}', 'fresh-corner-request')
ON CONFLICT (corner_id) DO NOTHING;
INSERT INTO agent_turns(room_id, request_id, agent_id, status)
VALUES ('88888888-8888-4888-8888-888888888888', 'fresh-corner-request', repeat('a', 64), 'working')
ON CONFLICT (room_id, request_id, agent_id) DO NOTHING;
INSERT INTO messages(id, room_id, author_id, text, presentation, card_type, card)
VALUES (repeat('8', 64), '33333333-3333-4333-8333-333333333333', repeat('a', 64), '', 'card', 'daemon-fact', '{"type":"corner-open","cornerId":"88888888-8888-4888-8888-888888888888","name":"Live Auto-selected Corner","objective":"Prove that a newly opened corner selects itself into a present work pane."}')
ON CONFLICT (id) DO NOTHING;
COMMIT;
