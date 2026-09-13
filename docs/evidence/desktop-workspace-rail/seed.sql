\set ON_ERROR_STOP on

-- Deterministic local-only proof data for the real Expo desktop web app.
-- The signed-in identity is `local:captain` from the development phone exchange.
BEGIN;

DELETE FROM memberships
WHERE identity_id = '913c42067daddb44ab84270088b65547077049070a3065c06bb6263c32e8aecb';
DELETE FROM memberships
WHERE workspace_id IN (
  '11111111-1111-4111-8111-111111111111',
  '22222222-2222-4222-8222-222222222222'
);

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
  ('11111111-1111-4111-8111-111111111111', 'Burd Nest', 'invite-only'),
  ('22222222-2222-4222-8222-222222222222', 'Empty Flight', 'invite-only')
ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, visibility = EXCLUDED.visibility;

INSERT INTO rooms(id, workspace_id, created_by, name, repository_resolution, created_at) VALUES
  ('33333333-3333-4333-8333-333333333333', '11111111-1111-4111-8111-111111111111', '913c42067daddb44ab84270088b65547077049070a3065c06bb6263c32e8aecb', 'General', 'none', now())
ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name;

INSERT INTO memberships(workspace_id, room_id, identity_id, role) VALUES
  ('11111111-1111-4111-8111-111111111111', NULL, '913c42067daddb44ab84270088b65547077049070a3065c06bb6263c32e8aecb', 'owner'),
  ('11111111-1111-4111-8111-111111111111', NULL, repeat('a', 64), 'member'),
  ('11111111-1111-4111-8111-111111111111', '33333333-3333-4333-8333-333333333333', '913c42067daddb44ab84270088b65547077049070a3065c06bb6263c32e8aecb', 'owner'),
  ('11111111-1111-4111-8111-111111111111', '33333333-3333-4333-8333-333333333333', repeat('a', 64), 'member'),
  ('22222222-2222-4222-8222-222222222222', NULL, '913c42067daddb44ab84270088b65547077049070a3065c06bb6263c32e8aecb', 'owner');

INSERT INTO messages(id, room_id, author_id, text, presentation, created_at) VALUES
  (repeat('3', 64), '33333333-3333-4333-8333-333333333333', repeat('a', 64), 'The rail is ready for your review.', 'message', now())
ON CONFLICT (id) DO UPDATE SET text = EXCLUDED.text, created_at = EXCLUDED.created_at;

COMMIT;
