# Retiring the Beeline Welcome Workspace and Greeter

The shared "Beeline Welcome" Workspace (`bee11e00-0000-4000-8000-000000000001`) and its
`#welcome` Room used to be the landing place for every new person. They are replaced by the
create-or-join onboarding: a person with no Workspace sees the choice screen, and an invite link
takes them straight to its own Workspace.

This runbook is the release owner's sequence. Nothing destructive runs until step 4 arms it.

## What already changed in this server image

- `migrate()` no longer reseeds the Welcome Workspace at boot.
- GitHub sign-in no longer adds anyone to it. The Play review identity lands in its own fixed
  `Beeline Review` Workspace (`apps/server/src/review-proof-fixture.ts`).
- `createWorkspace` creates a public `#general` Room with the Workspace
  (`apps/server/src/first-room.ts`).
- Release notices go to the `@system` DM in the Workspace each person joined first, never
  Welcome while they belong to another. A person with no Workspace gets none.

Old clients survive a zero-Workspace person: their empty deck still offers "Create a Workspace",
so no client is left on a dead route.

## Sequence

1. **Ship the clients.** Release the phone/web/desktop build that carries the choice screen,
   invite-through-sign-in, and create wizard. Wait until adoption of that build is acceptable.
2. **Run the read-only preflight** against production and review it:

   ```sh
   MIGRATION_DATABASE_URL=… node apps/server/dist/index.js --welcome-retirement-preflight
   ```

   It reports:
   - active members, and how many people have no other Workspace;
   - every agent member, with its owner, tokens, grants, schedules and open corners;
   - message and Room counts;
   - the per-person Workspace-scoped rows the delete will cascade: wallet bindings, Workbench
     connectors, Google grants, agent grants, schedules.

   It writes nothing. Identify the exact Greeter agent id from the `agents` list, never by name.
3. **Check the release canary.** If the `SERVER_CANARY_ROOM_ID` secret names the `#welcome` Room
   (`bee11e00-0000-4000-8000-000000000002`), repoint it to the review proof Room
   `bee11e00-0000-4000-8000-000000000103`. The canary's review sign-in re-creates that Room in
   the review Workspace, so the canary does not start failing once Welcome is gone.
4. **Arm the retirement.** Set the repository variable `BEELINE_RETIRE_WELCOME_GREETER_ID` to the
   Greeter's exact agent id. Leave it unset to skip the step entirely. The next
   unified release's migration step runs `retireWelcomeWorkspace`
   (`apps/server/src/welcome-retirement.ts`) in one transaction:
   - it refuses and changes nothing unless the id is an agent member of Welcome;
   - it retires that Greeter with `removeAgent`'s effects (`agent-retirement.ts`);
   - it revokes the tokens of any other agent whose only home was Welcome;
   - it writes a system-owned `workspace_deletions` audit row;
   - it deletes the Workspace, and the schema cascades its Rooms and memberships;
   - it records `welcome-workspace-retirement-v1` in `beeline_release_steps` last.

   A retry, or any later release, sees the marker and does nothing.
5. **Verify.**
   - The preflight now reports `workspace: null` plus the marker.
   - A brand-new sign-in lands on the choice screen.
   - An invite link reaches its Workspace.
   - A person with another Workspace still opens it.
   - A Welcome-only person lands on the choice screen.
6. **Clean up later.** Once no supported client or script depends on the fixed ids, remove
   `DEFAULT_WORKSPACE_ID`/`WELCOME_ROOM_ID` and the release-notice preference that mentions them,
   and unset the repository variable.
