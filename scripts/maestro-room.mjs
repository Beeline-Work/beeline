import { pathToFileURL } from 'node:url';

/** Read an existing review Room through the same API used by the installed app. */
export async function readMaestroRoom({ origin, reviewSecret, fetchImpl = fetch }) {
  const request = async (path, options) => {
    const response = await fetchImpl(`${origin}${path}`, {
      ...options,
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`Maestro preflight ${path}: HTTP ${response.status}`);
    return response.json();
  };
  const session = await request('/v1/auth/review/exchange', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ secret: reviewSecret }),
  });
  if (typeof session.accessToken !== 'string') throw new Error('Review exchange returned no token');
  const options = { headers: { authorization: `Bearer ${session.accessToken}` } };
  const workspaces = await request('/v1/phone/workspaces', options);
  for (const workspace of workspaces.workspaces ?? []) {
    const chats = await request(
      `/v1/phone/workspaces/${encodeURIComponent(workspace.id)}/chats`,
      options,
    );
    const roomId = chats.chats?.find((chat) => typeof chat?.room?.id === 'string')?.room.id;
    if (!roomId) continue;
    const room = await request(`/v1/phone/rooms/${encodeURIComponent(roomId)}`, options);
    if (room.room?.id !== roomId || !Array.isArray(room.messages))
      throw new Error('Review Room returned an invalid projection');
    return roomId;
  }
  throw new Error('Review identity has no Room; configure its Workspace before running Maestro');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const reviewSecret = process.env.BEELINE_REVIEW_SECRET;
  if (!reviewSecret)
    throw new Error('BEELINE_REVIEW_SECRET is required for the review sign-in smoke');
  console.log(
    await readMaestroRoom({
      origin: process.env.SERVER_ORIGIN ?? 'https://server.usebeeline.app',
      reviewSecret,
    }),
  );
}
