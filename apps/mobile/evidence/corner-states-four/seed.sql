\set ON_ERROR_STOP on

-- Deterministic local-only proof data for the real Expo web app.
BEGIN;

DELETE FROM rooms WHERE id = '22222222-2222-4222-8222-222222222222';
DELETE FROM workspaces WHERE id = '11111111-1111-4111-8111-111111111111';

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

INSERT INTO workspaces(id, name, visibility)
VALUES ('11111111-1111-4111-8111-111111111111', 'Beeline Work', 'invite-only');

INSERT INTO rooms(id, workspace_id, parent_id, created_by, name, repository_resolution, created_at) VALUES
  ('22222222-2222-4222-8222-222222222222', '11111111-1111-4111-8111-111111111111', NULL, '913c42067daddb44ab84270088b65547077049070a3065c06bb6263c32e8aecb', 'Corner state canon', 'none', '2026-09-13 08:00:00-04'),
  ('33333333-3333-4333-8333-333333333333', '11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222', '913c42067daddb44ab84270088b65547077049070a3065c06bb6263c32e8aecb', 'Working turn', 'none', '2026-09-13 08:04:00-04'),
  ('44444444-4444-4444-8444-444444444444', '11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222', '913c42067daddb44ab84270088b65547077049070a3065c06bb6263c32e8aecb', 'Waiting answer', 'none', '2026-09-13 08:03:00-04'),
  ('55555555-5555-4555-8555-555555555555', '11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222', '913c42067daddb44ab84270088b65547077049070a3065c06bb6263c32e8aecb', 'Review checks', 'none', '2026-09-13 08:02:00-04'),
  ('66666666-6666-4666-8666-666666666666', '11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222', '913c42067daddb44ab84270088b65547077049070a3065c06bb6263c32e8aecb', 'Archived change', 'none', '2026-09-13 08:01:00-04');

INSERT INTO memberships(workspace_id, room_id, identity_id, role)
SELECT '11111111-1111-4111-8111-111111111111', room_id, identity_id, role
FROM (VALUES
  (NULL::uuid, '913c42067daddb44ab84270088b65547077049070a3065c06bb6263c32e8aecb', 'owner'),
  (NULL::uuid, repeat('a', 64), 'member'),
  ('22222222-2222-4222-8222-222222222222'::uuid, '913c42067daddb44ab84270088b65547077049070a3065c06bb6263c32e8aecb', 'owner'),
  ('22222222-2222-4222-8222-222222222222'::uuid, repeat('a', 64), 'member'),
  ('33333333-3333-4333-8333-333333333333'::uuid, '913c42067daddb44ab84270088b65547077049070a3065c06bb6263c32e8aecb', 'member'),
  ('33333333-3333-4333-8333-333333333333'::uuid, repeat('a', 64), 'member'),
  ('44444444-4444-4444-8444-444444444444'::uuid, '913c42067daddb44ab84270088b65547077049070a3065c06bb6263c32e8aecb', 'member'),
  ('44444444-4444-4444-8444-444444444444'::uuid, repeat('a', 64), 'member'),
  ('55555555-5555-4555-8555-555555555555'::uuid, '913c42067daddb44ab84270088b65547077049070a3065c06bb6263c32e8aecb', 'member'),
  ('55555555-5555-4555-8555-555555555555'::uuid, repeat('a', 64), 'member'),
  ('66666666-6666-4666-8666-666666666666'::uuid, '913c42067daddb44ab84270088b65547077049070a3065c06bb6263c32e8aecb', 'member'),
  ('66666666-6666-4666-8666-666666666666'::uuid, repeat('a', 64), 'member')
) AS rows(room_id, identity_id, role);

INSERT INTO corner_facts(corner_id, owner_agent_id, objective, lifecycle) VALUES
  ('33333333-3333-4333-8333-333333333333', repeat('a', 64), 'Implement the server-owned four-state contract.', '{"lifecycle":"working","checks":"unknown"}'),
  ('44444444-4444-4444-8444-444444444444', repeat('a', 64), 'Waiting for a person to answer the corner question.', '{"lifecycle":"unknown","checks":"unknown","reason":"failure"}'),
  ('55555555-5555-4555-8555-555555555555', repeat('a', 64), 'Review the pull request and its failed checks.', '{"lifecycle":"in-review","checks":"failing","pr":{"number":1169,"url":"https://github.com/Beeline-Work/beeline/pull/1169","title":"One corner state machine","targetBranch":"main","headSha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}}'),
  ('66666666-6666-4666-8666-666666666666', repeat('a', 64), 'A landed corner retained as history.', '{"lifecycle":"done","checks":"passing","outcome":"landed"}');

INSERT INTO agent_turns(room_id, request_id, agent_id, status, started_at, created_at) VALUES
  ('33333333-3333-4333-8333-333333333333', repeat('1', 64), repeat('a', 64), 'working', now(), now());

INSERT INTO messages(id, room_id, author_id, text, presentation, created_at) VALUES
  (repeat('2', 64), '22222222-2222-4222-8222-222222222222', '913c42067daddb44ab84270088b65547077049070a3065c06bb6263c32e8aecb', 'One state machine, owned by the server.', 'message', now()),
  (repeat('3', 64), '33333333-3333-4333-8333-333333333333', repeat('a', 64), 'Deriving the contract field now.', 'message', now()),
  (repeat('4', 64), '44444444-4444-4444-8444-444444444444', repeat('a', 64), 'I need a person before continuing.', 'message', now()),
  (repeat('5', 64), '55555555-5555-4555-8555-555555555555', repeat('a', 64), 'The PR is ready for review.', 'message', now()),
  (repeat('6', 64), '66666666-6666-4666-8666-666666666666', repeat('a', 64), 'This change has landed.', 'message', now());

COMMIT;
