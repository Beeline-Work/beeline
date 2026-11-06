import { cornerObjectiveSql } from '.././corner-objective.js';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { PhoneService } from '.././phone-service.js';
import { monolithFixture, HUMAN, ROOM } from '../test-fixtures/test-support-monolith.js';

describe('monolith integration: corner-briefs', () => {
const fixture = monolithFixture();


  it('requires a continuous corner name and normalizes an untidy objective', async () => {
    const missing = await fixture.daemonOperation('createCorner', {
      roomId: ROOM,
      requestId: 'corner-name-missing',
      objective: 'Ship the widget',
    });
    expect(missing.status).toBe(400);
    expect(await missing.json()).toEqual({
      error: 'the name is required; give a title of at most 3 words',
    });

    const tooLong = await fixture.daemonOperation('createCorner', {
      roomId: ROOM,
      requestId: 'corner-name-too-long',
      name: 'far too many words here',
      objective: 'Ship the widget',
    });
    expect(tooLong.status).toBe(503);
    expect(await tooLong.json()).toEqual({ error: 'the name must not contain whitespace; use hyphens between words' });

    // Untidy is not wrong: line breaks and double spaces are flattened, and
    // the objective that used to be refused outright now opens a corner.
    const created = await fixture.daemonOperation('createCorner', {
      roomId: ROOM,
      requestId: 'corner-name-normalised',
      name: 'widget-ledger',
      objective: 'Ship the widget\nend to  end',
    });
    expect(created.status).toBe(200);
    const { cornerId } = (await created.json()) as { cornerId: string };
    const corner = await fixture.database.query<{ name: string; objective: string }>(
      `SELECT r.name,${cornerObjectiveSql('r')} objective FROM rooms r JOIN corner_facts cf ON cf.corner_id=r.id WHERE r.id=$1`,
      [cornerId],
    );
    expect(corner.rows[0]).toEqual({
      name: 'widget-ledger',
      objective: 'Ship the widget end to end',
    });
  });


  it('renders a legacy Room opening with its name and without private objective or DM text', async () => {
    const requestId = 'corner-legacy-card';
    const sourceMessageId = createHash('sha256').update(requestId).digest('hex');
    await fixture.database.query(
      `INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,'Open a corner for the room list')`,
      [sourceMessageId, ROOM, HUMAN],
    );
    const created = await fixture.daemonOperation('createCorner', {
      roomId: ROOM,
      requestId,
      name: 'Legacy-corner',
      objective: 'Rework the room list so every corner row carries a state mark',
    });
    expect(created.status).toBe(200);
    const { cornerId } = (await created.json()) as { cornerId: string };
    // A card written before the name existed carries only the objective.
    await fixture.database.query(
      `UPDATE messages SET card=(card-'name')||'{"sourceMessageId":"legacy-request","objective":"Private DM request: Rework the room list so every corner row carries a state mark"}'::jsonb
       WHERE room_id=$1 AND card->>'cornerId'=$2`,
      [ROOM, cornerId],
    );
    const room = (await new PhoneService(fixture.database, fixture.origin).readRoom(ROOM, HUMAN))!;
    const card = room.messages.find((message) => message.daemonFact?.cornerId === cornerId);
    expect(card?.daemonFact).toMatchObject({
      name: 'Legacy-corner',
      objective: 'Legacy-corner',
      type: 'corner-open',
    });
    expect(JSON.stringify(card)).not.toContain('Rework the room list');
    expect(JSON.stringify(card)).not.toContain('Private DM request');
    expect(
      (await new PhoneService(fixture.database, fixture.origin).readCorners(ROOM, HUMAN))?.corners.find(
        (item) => item.corner.id === cornerId,
      )?.corner.about,
    ).toBe('Rework the room list so every corner row carries a state mark');
  });
});
