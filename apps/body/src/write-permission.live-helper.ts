import {
  tagValue,
  WRITE_PERMISSION_REQUEST_TAG,
  type BuzzClient,
  type SessionEvent,
  type WritePermissionDecision,
} from '@beeline/buzz-client';

export async function waitForWritePermissionPrompt(
  client: BuzzClient,
  channelId: string,
  requestId: string,
  timeoutMs = 120_000,
): Promise<SessionEvent> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const events = await client.sessionEventsBackfill(channelId, { limit: 500 });
    const request = events.find(
      (event) =>
        event.event.tags.some(
          (tag) => tag[0] === 't' && tag[1] === WRITE_PERMISSION_REQUEST_TAG,
        ) && tagValue(event.event, 'request') === requestId,
    );
    if (request) return request;
    await new Promise((resolveWait) => setTimeout(resolveWait, 500));
  }
  throw new Error(`write permission prompt not visible for request ${requestId}`);
}

export async function respondToWritePermission(
  client: BuzzClient,
  channelId: string,
  requestId: string,
  agentPubkey: string,
  decision: WritePermissionDecision,
): Promise<SessionEvent> {
  const prompt = await waitForWritePermissionPrompt(client, channelId, requestId);
  const permissionId = tagValue(prompt.event, 'permission');
  if (!permissionId) throw new Error('write permission prompt missing permission id');
  await client.respondToWritePermission(
    channelId,
    permissionId,
    requestId,
    agentPubkey,
    decision,
  );
  return prompt;
}

