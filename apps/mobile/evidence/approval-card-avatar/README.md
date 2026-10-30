# R1 — permission-card avatar

The stored grant and Squire approval identities contain a relative avatar URL and no face. A regenerated avatar also leaves the snapshot pointing at a deleted avatar ID. PhoneService returned those snapshots unchanged, while author and roster identities used the current identity projection.

The server now resolves the agent, owner and grant requester with one indexed identity query per message batch and the existing absolute-URL/face projection. Missing identities retain the snapshot with its URL made absolute. Card data and old-phone field names stay compatible.

## Reproduced

On baseline `e20fb93ad`, run the new regression:

```
npm test -w @beeline/server -- src/approval-card-identity.test.ts
```

R1 failed: expected the current absolute avatar and `face: fox`; received `/v1/agent-avatars/55555555-5555-4555-8555-555555555555`, the old name and no face. The test creates a real System DM through `ensureSystemDirectMessageRoom`, without the agent in its roster, and also reads a Room containing the agent.

## Demonstrated

The same regression passes for both card types, the System DM and Room, and initial and history reads. The built-service stand-in also passes:

```
npm run build -w @beeline/server
node --import tsx scripts/prove-approval-card-avatar.mjs
```

The built script migrates an isolated PGlite database, seeds current identities and stale approval snapshots, creates a System DM, and reads the cards through the built PhoneService. It asserts absolute current avatar URLs and face data, plus the owner's absolute avatar and current grant requester.

## Visual evidence and limits

`bone-before.png`, `bone-after.png`, `obsidian-before.png`, and `obsidian-after.png` are Android emulator Chrome captures of the unchanged production GrantRequestCard/AgentApprovalCard/IdentityMark components through React Native Web, at phone size. They use the built projection's seeded identity and a fixture portrait served from the absolute generated-avatar endpoint. Before uses the stale relative avatar path; after uses the current absolute path. Web's image-error fallback draws an assigned creature before; after shows the fixture portrait.

These are local component stand-ins, not a signed-in production native DM or Jellybean's actual portrait. The corner emulator initially had no running device; it was booted and had Chrome but no Expo Go installation. No production DM data or sign-in was used. The server regression is the direct proof for the native failure: a native reader now receives an absolute current URI and face, independent of its roster.

Validation: root typecheck, server build, approval identity/source regressions, agent removal regressions, and the built-service R1 script passed.
