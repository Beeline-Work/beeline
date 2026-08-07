import Fastify, { type FastifyInstance } from 'fastify';
import { WebSocketServer } from 'ws';

/**
 * App shell only. This will host the Phase 0 merge worker (see
 * spec.md, "Build sequence" — Phase 0: prove the gate headlessly) —
 * that logic is out of scope here and owned by another agent.
 */
export function buildServer(): FastifyInstance {
  const app = Fastify({ logger: true });

  app.get('/health', async () => ({ status: 'ok' }));

  const wss = new WebSocketServer({ noServer: true });

  app.server.on('upgrade', (req, socket, head) => {
    if (req.url !== '/ws') {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  });

  app.addHook('onClose', (_instance, done) => {
    wss.close(() => done());
  });

  return app;
}

async function start() {
  const app = buildServer();
  const port = Number(process.env.PORT ?? 3000);
  await app.listen({ port, host: '0.0.0.0' });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  start().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
