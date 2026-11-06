import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [directory, option, fixture] = process.argv.slice(2);
try {
  if (!directory || (option && (option !== '--events' || !fixture))) throw new Error('Invalid verification arguments');
  const install = readFileSync(join(directory, 'install-id.txt'), 'utf8').trim();
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(install)) throw new Error('Missing capture install identifier');
  let rows;
  if (option === '--events') {
    // Offline reproduction of saved server evidence; never used by the workflow.
    rows = JSON.parse(readFileSync(fixture, 'utf8'));
  } else {
    const connection = process.env.CAPTURE_DATABASE_URL;
    if (!connection) throw new Error('CAPTURE_DATABASE_URL is required');
    const hostname = new URL(connection).hostname;
    if (!hostname.endsWith('.neon.tech')) throw new Error('Expected production Neon database');
    const response = await fetch(`https://${hostname}/sql`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Neon-Connection-String': connection },
      body: JSON.stringify({
        query: `SELECT f.install_id, f.attempt_id, f.event, f.provider, f.outcome,
          f.recorded_at, s.occurred_at AS server_at FROM signin_funnel_events f
          LEFT JOIN signin_attempt_events s ON s.install_id=f.install_id
            AND s.funnel_attempt_id=f.attempt_id AND s.provider=f.provider AND s.stage='started'
          WHERE f.install_id=$1 AND f.event IN ('provider_tapped','callback_result')
          ORDER BY f.recorded_at`,
        params: [install],
      }),
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new Error(`Production event query returned HTTP ${response.status}`);
    rows = (await response.json()).rows;
  }
  writeFileSync(join(directory, 'production-start-events.json'), JSON.stringify(rows, null, 2));
  const verified = [];
  for (const provider of ['github', 'google']) {
    const screenshot = `${provider}-final.png`;
    const png = readFileSync(join(directory, screenshot));
    if (png.length <= 8 || png.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw new Error(`${provider}: screenshot missing or invalid`);
    const tap = rows.filter(row => row.install_id === install && row.provider === provider && row.event === 'provider_tapped').at(-1);
    const delta = tap?.server_at ? Date.parse(tap.server_at) - Date.parse(tap.recorded_at) : NaN;
    if (!Number.isFinite(delta) || delta < 0 || delta > 30000) throw new Error(`${provider}: no correlated production start within 30 seconds of tap`);
    verified.push({ provider, install_id: install, attempt_id: tap.attempt_id, tapped_at: tap.recorded_at, started_at: tap.server_at, screenshot });
  }
  writeFileSync(join(directory, 'verified-provider-starts.json'), JSON.stringify(verified, null, 2));
  console.log('GitHub and Google screenshots saved; correlated production starts are within 30 seconds of each tap');
} catch (error) {
  // Never print database response bodies, connection strings or driver errors.
  console.error(error instanceof TypeError ? 'Production start verification failed' : error.message);
  process.exitCode = 1;
}
