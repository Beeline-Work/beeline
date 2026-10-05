import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { expect, it, vi } from 'vitest';
import sharp from 'sharp';
import { migrate } from '../../server/src/database.js';
import { PgliteDatabase } from '../../server/src/test-support.js';
import { TokenAuth } from '../../server/src/auth.js';
import { PhoneService } from '../../server/src/phone-service.js';
import { DaemonService } from '../../server/src/daemon-service.js';
import { LiveHub } from '../../server/src/live.js';
import { createBeelineServer } from '../../server/src/server.js';
import { createAgentCommand, claimAgentCommand } from '../../server/src/agent-command.js';
import type { AgentCommand } from '@beeline/api-contract/daemon';
import { CommandExecutionContext } from './server-command-intake.js';
import { agentToolsFor, callAgentTool } from './read-only-mcp.js';

it(
  'saves a minimal drawing through set_avatar and reads the persisted image',
  { timeout: 60_000 },
  async () => {
    const workspace = '11111111-1111-4111-8111-111111111111';
    const room = '22222222-2222-4222-8222-222222222222';
    const human = 'a'.repeat(64);
    const agent = 'b'.repeat(64);
    const database = new PgliteDatabase();
    const root = await mkdtemp(join(tmpdir(), 'beeline-avatar-e2e-'));
    const auth = new TokenAuth(database, async (proof) => ({
      subject: proof,
      login: proof,
      name: 'Owner',
    }));
    const live = new LiveHub();
    const phone = new PhoneService(database, 'http://placeholder');
    const server = createBeelineServer({
      database,
      auth,
      phone,
      daemon: new DaemonService(database, live),
      live,
    });
    try {
      await migrate(database);
      await database.query(
        `INSERT INTO identities(id,kind,name,handle) VALUES($1,'human','Owner','owner'),($2,'agent','Bee','bee')`,
        [human, agent],
      );
      await database.query('INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)', [agent, human]);
      await database.query("INSERT INTO workspaces(id,name) VALUES($1,'Avatar test')", [workspace]);
      await database.query("INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'Avatar test')", [
        room,
        workspace,
      ]);
      for (const who of [human, agent]) {
        await database.query(
          `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,NULL,$2,$3),($1,$4,$2,$3)`,
          [workspace, who, who === human ? 'owner' : 'member', room],
        );
      }
      await database.query(
        "INSERT INTO messages(id,room_id,author_id,text) VALUES('avatar-request',$1,$2,'Draw my avatar')",
        [room, human],
      );
      const command = (await createAgentCommand(database, {
        roomId: room,
        agentId: agent,
        sourceMessageId: 'avatar-request',
        reason: 'human_tag',
      }))!;
      const context = new CommandExecutionContext(root);
      await context.enter({
        roomId: room,
        turnRequestId: command.turn_request_id,
        rootCommandId: command.root_command_id,
      } as AgentCommand);
      await claimAgentCommand(database, room, agent, command.id, context.generationId);
      const exchange = await auth.createDaemonExchange(agent);
      const token = (await auth.exchangeDaemonToken(exchange.exchangeToken))!.daemonToken;
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      vi.stubEnv('BEELINE_DAEMON_BASE_URL', origin);
      vi.stubEnv('BEELINE_DAEMON_TOKEN', token);
      vi.stubEnv('BEELINE_DAEMON_ROOM_ID', room);
      vi.stubEnv('BEELINE_DAEMON_CORNER_ID', '');
      vi.stubEnv('BEELINE_TURN_CONTEXT_FILE', context.path);
      const drawing = [{ type: 'circle', cx: 50, cy: 50, r: 30, fill: 'bone' }];
      const saved = JSON.parse(await callAgentTool('set_avatar', { drawing }, 'avatar-call')) as {
        id: string;
      };
      expect(saved.id).toBeTruthy();
      const read = JSON.parse(await callAgentTool('get_avatar', {}, 'avatar-read')) as {
        drawing: unknown;
      };
      expect(read.drawing).toEqual(drawing);
      const persisted = (
        await database.query<{ avatar: string }>('SELECT avatar FROM identities WHERE id=$1', [
          agent,
        ])
      ).rows[0]!;
      const image = await fetch(`${origin}${persisted.avatar}`);
      expect(image.status).toBe(200);
      expect(image.headers.get('content-type')).toBe('image/webp');
      const bytes = Buffer.from(await image.arrayBuffer());
      expect(await sharp(bytes).metadata()).toMatchObject({
        width: 256,
        height: 256,
        format: 'webp',
      });
      console.log(
        'Demonstrated: set_avatar saved a single circle; get_avatar returned its drawing; the persisted avatar URL served a 256×256 WebP',
      );
      // Exercise every advertised attribute, including optional ones, through the
      // same save path. An attribute from another shape must not be advertised.
      const schema = agentToolsFor(true, false).find((tool) => tool.name === 'set_avatar')!
        .inputSchema as {
        properties: { drawing: { items: ShapeSchema & { anyOf?: ShapeSchema[] } } };
      };
      type ShapeSchema = { properties: { type: { enum: string[] } } & Record<string, unknown> };
      const examples: Record<string, unknown> = {
        fill: 'bone',
        stroke: 'ink',
        strokeWidth: 2,
        d: 'M20,20 L80,20 L50,80 Z',
        points: '20,20 80,20 50,80',
        x: 20,
        y: 20,
        width: 60,
        height: 60,
        cx: 50,
        cy: 50,
        r: 30,
        rx: 20,
        ry: 30,
        x1: 20,
        y1: 20,
        x2: 80,
        y2: 80,
      };
      const items = schema.properties.drawing.items;
      for (const shapeSchema of items.anyOf ?? [items]) {
        for (const type of shapeSchema.properties.type.enum) {
          const shape = Object.fromEntries(
            Object.keys(shapeSchema.properties).map((key) => [
              key,
              key === 'type' ? type : examples[key],
            ]),
          );
          const receipt = JSON.parse(
            await callAgentTool('set_avatar', { drawing: [shape] }, `schema-${type}`),
          ) as { id: string };
          expect(receipt.id).toBeTruthy();
          expect(JSON.parse(await callAgentTool('get_avatar', {}, `read-${type}`)).drawing).toEqual(
            [shape],
          );
        }
      }
      console.log('Demonstrated: every shape saved with all of its advertised attributes');
    } finally {
      vi.unstubAllEnvs();
      if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
      await database.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);
