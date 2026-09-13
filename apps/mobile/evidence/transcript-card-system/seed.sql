\set ON_ERROR_STOP on

-- Deterministic local-only Room used to capture the real Expo web transcript.
-- The signed-in identity is `local:captain` from the development auth exchange.
BEGIN;

DELETE FROM rooms WHERE id = '22222222-2222-4222-8222-222222222222';
DELETE FROM workspaces WHERE id = '11111111-1111-4111-8111-111111111111';

UPDATE identities
SET name = 'Moon Scanner', handle = 'captain', face_id = 'fox'
WHERE id = '913c42067daddb44ab84270088b65547077049070a3065c06bb6263c32e8aecb';

INSERT INTO identities(id, kind, name, handle, face_id) VALUES
  (repeat('a', 64), 'agent', 'Hoots', 'hoots', 'owl'),
  (repeat('b', 64), 'agent', 'Sol', 'sol', 'hare')
ON CONFLICT (id) DO UPDATE
SET name = EXCLUDED.name, handle = EXCLUDED.handle, face_id = EXCLUDED.face_id;

INSERT INTO agents(agent_id, owner_id, soul) VALUES
  (repeat('a', 64), '913c42067daddb44ab84270088b65547077049070a3065c06bb6263c32e8aecb', '{"name":"Hoots","instructions":"Careful repository helper"}'),
  (repeat('b', 64), '913c42067daddb44ab84270088b65547077049070a3065c06bb6263c32e8aecb', '{"name":"Sol","instructions":"Release helper"}')
ON CONFLICT (agent_id) DO NOTHING;

INSERT INTO workspaces(id, name, visibility)
VALUES ('11111111-1111-4111-8111-111111111111', 'Beeline Work', 'invite-only');

INSERT INTO rooms(
  id, workspace_id, created_by, name, repository_key, repository_name,
  repository_remote, repository_target_branch, repository_resolution
) VALUES (
  '22222222-2222-4222-8222-222222222222',
  '11111111-1111-4111-8111-111111111111',
  '913c42067daddb44ab84270088b65547077049070a3065c06bb6263c32e8aecb',
  'beeline', 'Beeline-Work/beeline', 'beeline',
  'https://github.com/Beeline-Work/beeline.git', 'main', 'repository'
);

INSERT INTO memberships(workspace_id, room_id, identity_id, role) VALUES
  ('11111111-1111-4111-8111-111111111111', NULL, '913c42067daddb44ab84270088b65547077049070a3065c06bb6263c32e8aecb', 'owner'),
  ('11111111-1111-4111-8111-111111111111', NULL, repeat('a', 64), 'member'),
  ('11111111-1111-4111-8111-111111111111', NULL, repeat('b', 64), 'member'),
  ('11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222', '913c42067daddb44ab84270088b65547077049070a3065c06bb6263c32e8aecb', 'owner'),
  ('11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222', repeat('a', 64), 'member'),
  ('11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222', repeat('b', 64), 'member');

INSERT INTO messages(id, room_id, author_id, text, presentation, card_type, card, created_at) VALUES
  (repeat('0',63)||'1', '22222222-2222-4222-8222-222222222222', '913c42067daddb44ab84270088b65547077049070a3065c06bb6263c32e8aecb', '@hoots yes go open the corner', 'message', NULL, NULL, '2026-09-12 18:10:00-04'),
  (repeat('0',63)||'2', '22222222-2222-4222-8222-222222222222', repeat('a',64), 'Opened iOS Push Notifications', 'card', 'daemon-fact', '{"type":"corner-open","cornerId":"33333333-3333-4333-8333-333333333333","name":"iOS Push Notifications","objective":"Build APNs-based push registration for iOS mirroring the existing Android FCM flow."}', '2026-09-12 18:10:10-04'),
  (repeat('0',63)||'3', '22222222-2222-4222-8222-222222222222', '913c42067daddb44ab84270088b65547077049070a3065c06bb6263c32e8aecb', 'Corner landed', 'system', NULL, NULL, '2026-09-12 18:43:00-04'),
  (repeat('0',63)||'4', '22222222-2222-4222-8222-222222222222', repeat('b',64), 'Merged iOS Composer Fix', 'card', 'daemon-fact', '{"type":"corner-complete","cornerId":"44444444-4444-4444-8444-444444444444","name":"iOS Composer Fix","objective":"Keep the mobile composer visible while cards expand.","outcome":"landed","pullRequest":{"number":1156,"title":"iOS Composer Fix","url":"https://github.com/Beeline-Work/beeline/pull/1156","targetBranch":"main"}}', '2026-09-12 18:43:10-04'),
  (repeat('0',63)||'5', '22222222-2222-4222-8222-222222222222', '913c42067daddb44ab84270088b65547077049070a3065c06bb6263c32e8aecb', 'Repository activity', 'system', NULL, NULL, '2026-09-12 19:04:00-04'),
  (repeat('1',64), '22222222-2222-4222-8222-222222222222', repeat('a',64), 'PR merged', 'card', 'github-event', '{"type":"pull-request","action":"merged","actor":"lunchboxfortwo","title":"fix(body): guard corner push branches all the way through delivery","url":"https://github.com/Beeline-Work/beeline/pull/1160"}', '2026-09-12 19:04:10-04'),
  (repeat('2',64), '22222222-2222-4222-8222-222222222222', repeat('a',64), 'PR merged', 'card', 'github-event', '{"type":"pull-request","action":"merged","actor":"hoots","title":"fix(mobile): shorten grouped corner labels without losing context","url":"https://github.com/Beeline-Work/beeline/pull/1158"}', '2026-09-12 19:05:10-04'),
  (repeat('3',64), '22222222-2222-4222-8222-222222222222', repeat('a',64), 'PR opened', 'card', 'github-event', '{"type":"pull-request","action":"opened","actor":"hoots","title":"fix(mobile): simplify the add-agent sheet for narrow phones","url":"https://github.com/Beeline-Work/beeline/pull/1162"}', '2026-09-12 19:06:10-04'),
  (repeat('4',64), '22222222-2222-4222-8222-222222222222', repeat('a',64), 'PR merged', 'card', 'github-event', '{"type":"pull-request","action":"merged","actor":"hoots","title":"Keep the reviewer status current","url":"https://github.com/Beeline-Work/beeline/pull/1157"}', '2026-09-12 19:07:10-04'),
  (repeat('5',64), '22222222-2222-4222-8222-222222222222', repeat('a',64), 'PR merged', 'card', 'github-event', '{"type":"pull-request","action":"merged","actor":"sol","title":"Remove duplicate release rows","url":"https://github.com/Beeline-Work/beeline/pull/1155"}', '2026-09-12 19:08:10-04'),
  (repeat('6',64), '22222222-2222-4222-8222-222222222222', repeat('a',64), 'PR merged', 'card', 'github-event', '{"type":"pull-request","action":"merged","actor":"sol","title":"Share corner state safely","url":"https://github.com/Beeline-Work/beeline/pull/1154"}', '2026-09-12 19:09:10-04'),
  (repeat('7',64), '22222222-2222-4222-8222-222222222222', repeat('a',64), 'PR merged', 'card', 'github-event', '{"type":"pull-request","action":"merged","actor":"sol","title":"Bound room activity queries","url":"https://github.com/Beeline-Work/beeline/pull/1153"}', '2026-09-12 19:10:10-04'),
  (repeat('8',64), '22222222-2222-4222-8222-222222222222', repeat('a',64), 'PR merged', 'card', 'github-event', '{"type":"pull-request","action":"merged","actor":"hoots","title":"Improve corner cleanup","url":"https://github.com/Beeline-Work/beeline/pull/1152"}', '2026-09-12 19:11:10-04'),
  (repeat('9',64), '22222222-2222-4222-8222-222222222222', repeat('a',64), 'PR opened', 'card', 'github-event', '{"type":"pull-request","action":"opened","actor":"hoots","title":"fix(body): guard corner push branches all the way through delivery","url":"https://github.com/Beeline-Work/beeline/pull/1151"}', '2026-09-12 19:12:10-04'),
  (repeat('a',63)||'1', '22222222-2222-4222-8222-222222222222', '913c42067daddb44ab84270088b65547077049070a3065c06bb6263c32e8aecb', 'Release check', 'system', NULL, NULL, '2026-09-12 19:13:00-04'),
  (repeat('a',63)||'2', '22222222-2222-4222-8222-222222222222', repeat('b',64), 'Unified production release failed', 'card', 'daemon-fact', '{"type":"checks-failing","cornerId":"77777777-7777-4777-8777-777777777777","name":"Unified production release","objective":"Smoke check failed for the production release.","pullRequest":{"number":4127,"title":"Unified production release","url":"https://github.com/Beeline-Work/beeline/pull/4127","targetBranch":"main"}}', '2026-09-12 19:14:00-04'),
  (repeat('a',63)||'3', '22222222-2222-4222-8222-222222222222', '913c42067daddb44ab84270088b65547077049070a3065c06bb6263c32e8aecb', 'Approvals', 'system', NULL, NULL, '2026-09-12 19:15:00-04'),
  (repeat('b',63)||'1', '22222222-2222-4222-8222-222222222222', repeat('a',64), '@hoots asks to open an edit corner', 'card', 'permission', '{"permissionId":"permission-proof","requestId":"request-proof","agent":{"pubkey":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","kind":"agent","name":"Hoots","handle":"hoots","face":"owl"},"requester":{"pubkey":"913c42067daddb44ab84270088b65547077049070a3065c06bb6263c32e8aecb","kind":"human","name":"Moon Scanner","handle":"captain","face":"fox"},"tool":"Add the reviewer row to the Room sheet","repository":"Beeline-Work/beeline","status":"pending"}', '2026-09-12 19:40:00-04'),
  (repeat('b',63)||'2', '22222222-2222-4222-8222-222222222222', repeat('b',64), '@sol asks you', 'card', 'grant-request', '{"agent":{"pubkey":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","kind":"agent","name":"Sol","handle":"sol","face":"hare"},"owner":{"pubkey":"913c42067daddb44ab84270088b65547077049070a3065c06bb6263c32e8aecb","kind":"human","name":"Moon Scanner","handle":"captain","face":"fox"},"requester":{"pubkey":"913c42067daddb44ab84270088b65547077049070a3065c06bb6263c32e8aecb","kind":"human","name":"Moon Scanner","handle":"captain","face":"fox"},"grants":[{"grantId":"55555555-5555-4555-8555-555555555555","kind":"command","target":"bash scripts/smoke.sh","reason":"fix the stale release smoke check","status":"pending","requestedBy":{"pubkey":"913c42067daddb44ab84270088b65547077049070a3065c06bb6263c32e8aecb","kind":"human","name":"Moon Scanner","handle":"captain","face":"fox"},"roomId":"22222222-2222-4222-8222-222222222222","createdAt":1789256460,"auto":false,"script":{"path":"scripts/smoke.sh","sha256":"3a0845eb52a860797fe2c4e52ff57873178721cefcfbbe976cc7273ead616c79","bytes":31,"contents":"curl -sf $URL/health || exit 1"}}]}', '2026-09-12 19:41:00-04'),
  (repeat('b',63)||'3', '22222222-2222-4222-8222-222222222222', repeat('a',64), '@hoots asks you', 'card', 'grant-request', '{"agent":{"pubkey":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","kind":"agent","name":"Hoots","handle":"hoots","face":"owl"},"owner":{"pubkey":"913c42067daddb44ab84270088b65547077049070a3065c06bb6263c32e8aecb","kind":"human","name":"Moon Scanner","handle":"captain","face":"fox"},"requester":{"pubkey":"913c42067daddb44ab84270088b65547077049070a3065c06bb6263c32e8aecb","kind":"human","name":"Moon Scanner","handle":"captain","face":"fox"},"grants":[{"grantId":"66666666-6666-4666-8666-666666666666","kind":"host","target":"api.github.com","reason":"read release status","status":"denied","requestedBy":{"pubkey":"913c42067daddb44ab84270088b65547077049070a3065c06bb6263c32e8aecb","kind":"human","name":"Moon Scanner","handle":"captain","face":"fox"},"decidedBy":{"pubkey":"913c42067daddb44ab84270088b65547077049070a3065c06bb6263c32e8aecb","kind":"human","name":"Moon Scanner","handle":"captain","face":"fox"},"roomId":"22222222-2222-4222-8222-222222222222","createdAt":1789256520,"decidedAt":1789256580,"auto":false}]}', '2026-09-12 19:42:00-04'),
  (repeat('b',63)||'4', '22222222-2222-4222-8222-222222222222', repeat('a',64), '@hoots asks to change the target branch', 'card', 'target-branch', '{"proposalId":"target-proof","from":"main","to":"release/0.0.98","repository":"Beeline-Work/beeline","agent":{"pubkey":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","kind":"agent","name":"Hoots","handle":"hoots","face":"owl"},"requester":{"pubkey":"913c42067daddb44ab84270088b65547077049070a3065c06bb6263c32e8aecb","kind":"human","name":"Moon Scanner","handle":"captain","face":"fox"}}', '2026-09-12 19:44:00-04');

COMMIT;
