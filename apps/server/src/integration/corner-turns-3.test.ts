import { migrateMembershipSubscriptions } from '.././agent-subscriptions.js';
import { describe, expect, it } from 'vitest';
import { REVIEW_IDENTITY_ID } from '.././review-access.js';
import { monolithFixture, AGENT, REVIEW_SECRET, ROOM } from '../test-fixtures/test-support-monolith.js';

describe('monolith integration: corner-turns', () => {
const fixture = monolithFixture();


  it('signs the Google Play reviewer in from the link alone, and hides every miss behind a 404', async () => {
    const redeemed = await fixture.redeemReview(REVIEW_SECRET);
    expect(redeemed.status).toBe(200);
    const session = (await redeemed.json()) as { identityId: string; accessToken: string };
    expect(session.identityId).toBe(REVIEW_IDENTITY_ID);

    // The session is the same one a GitHub ticket issues: it reads the app.
    const workspaces = await fixture.request('/v1/phone/workspaces', 'GET', undefined, session.accessToken);
    expect(workspaces.status).toBe(200);
    const view = (await workspaces.json()) as { workspaces: { name: string }[] };
    expect(view.workspaces.map((workspace) => workspace.name)).toEqual(['Beeline Review']);

    // A wrong secret is an ordinary 404 carrying nothing a guesser can use, and
    // it is the same answer for a malformed one and for a missing field.
    for (const wrong of [`${REVIEW_SECRET}x`, 'nope', undefined, 12]) {
      const refused = await fixture.redeemReview(wrong);
      expect(refused.status).toBe(404);
      expect(await refused.json()).toEqual({ error: 'not_found' });
    }
  });


  it('opens a corner that inherits only Room-level subscriptions from a stale parent row', async () => {
    // A legacy row (from before subscribe_events refused per-item kinds) could
    // still carry one. Opening a corner must not resurrect it there.
    await fixture.database.query(
      `UPDATE memberships SET event_subscriptions='["joined","grant-decided"]'::jsonb
       WHERE room_id=$1 AND identity_id=$2`,
      [ROOM, AGENT],
    );
    await migrateMembershipSubscriptions(fixture.database);
    const created = await fixture.daemonOperation('createCorner', {
      roomId: ROOM,
      requestId: 'corner-subscription-inherit-request',
      name: 'Inherit-check',
      objective: 'Check what a new corner inherits',
    });
    expect(created.status).toBe(200);
    const { cornerId } = (await created.json()) as { cornerId: string };
    const inherited = await fixture.database.query<{ event_subscriptions: string[] }>(
      `SELECT event_subscriptions FROM room_access WHERE room_id=$1 AND identity_id=$2`,
      [cornerId, AGENT],
    );
    expect(inherited.rows[0]!.event_subscriptions).toEqual(['joined']);
  });
});
