import type { IncomingMessage, ServerResponse } from "node:http";
import { InvitePreviewAccess } from "./invite-preview.js";
import { HelperVersionGate } from "./helper-version-gate.js";
import { isMediaId } from "./media-ttl.js";
import { runnableOrigin } from "./runnable-artifact.js";
import { PhoneOperationError } from "./phone-operations.js";
import { wantsCompactView, COMPACT_VIEW_HEADER, compactRoomView, compactRoomHistoryView } from "./compact-room-view.js";
import type { RoomHistoryView } from "@beeline/api-contract/phone";
import { TRANSCRIPTION_MAXIMUM_BYTES } from "./speech-transcription.js";
import { ARTIFACT_MAXIMUM_BYTES, decodeArtifactTitleHeader } from "@beeline/api-contract/daemon";
import { owedMentions } from "./owed-mentions.js";
import { DAEMON_OPERATION_NAMES } from "./daemon-service.js";
import { ServerOptions, json, bytes, body } from './server.js';
import { PhoneHttpOperation, phoneIdentity, phoneFamilies, daemonIdentity, refuseDaemon } from './server-create-beeline-server.js';



export async function routeAuthenticated(request: IncomingMessage, response: ServerResponse, options: ServerOptions, invitePreview: InvitePreviewAccess, liveHealth: () => object, helperVersionGate: HelperVersionGate, httpPhoneOperation: PhoneHttpOperation, url: URL, method: string): Promise<void> {

  const identityId = await phoneIdentity(request, options);
  if (
    method === 'GET' &&
    (url.pathname.startsWith('/v1/avatars/') || url.pathname.startsWith('/v1/agent-avatars/'))
  ) {
    const agentAvatar = url.pathname.startsWith('/v1/agent-avatars/');
    const id = url.pathname.slice(
      agentAvatar ? '/v1/agent-avatars/'.length : '/v1/avatars/'.length,
    );
    const avatar = isMediaId(id)
      ? (
          await options.database.query<{ bytes: Uint8Array }>(
            agentAvatar
              ? 'SELECT bytes FROM agent_avatars WHERE id=$1'
              : 'SELECT bytes FROM avatars WHERE id=$1',
            [id],
          )
        ).rows[0]
      : undefined;
    if (!avatar) {
      json(response, 404, { error: 'avatar_not_found' });
      return;
    }
    response.writeHead(200, {
      'content-type': 'image/webp',
      'content-length': String(avatar.bytes.length),
      'cache-control': 'public, max-age=31536000, immutable',
      'x-content-type-options': 'nosniff',
    });
    response.end(Buffer.from(avatar.bytes));
    return;
  }
  if (method === 'GET' && url.pathname.startsWith('/v1/media/')) {
    const last = url.pathname.slice('/v1/media/'.length);
    const playMatch = last.match(/^([0-9a-f-]{36})\/play$/);
    if (playMatch) {
      if (!identityId) { json(response, 401, { error: 'identity_required' }); return; }
      const origin = runnableOrigin();
      if (!origin || !options.objectService) { json(response, 503, { error: 'game_host_unavailable' }); return; }
      const link = await options.objectService.runnableLink(playMatch[1]!, origin);
      json(response, link ? 200 : 404, link ?? { error: 'game_not_found' });
      return;
    }
    // `open in browser`: redeem the capability token minted by `/link` (a
    // browser has no bearer token for the canonical media route) into a
    // ten-minute signed storage GET. The token — an HMAC over the object id
    // and expiry — keeps the raw storage hosts out of every shareable link.
    const openMatch = last.match(/^([0-9a-f-]+)\/open$/);
    if (method === 'GET' && openMatch && isMediaId(openMatch[1]!)) {
      if (!options.objectService) {
        json(response, 503, { error: 'object_storage_unavailable' });
        return;
      }
      const expires = Number(new URL(request.url ?? '', 'http://x').searchParams.get('expires'));
      const token = new URL(request.url ?? '', 'http://x').searchParams.get('token') ?? '';
      const result = await options.objectService.openMediaLink(openMatch[1]!, expires, token);
      if (result.kind === 'redirect') {
        response.writeHead(302, { location: result.location });
        response.end();
        return;
      }
      if (result.kind === 'expired') {
        json(response, 410, { error: 'media_expired' });
        return;
      }
      if (result.kind === 'missing' || result.kind === 'pending') {
        json(response, 404, { error: 'media_not_found' });
        return;
      }
      json(response, 403, { error: 'link_invalid_or_expired' });
      return;
    }
    // `open in browser` minting: hand out the capability URL at tap time.
    const linkMatch = last.match(/^([0-9a-f-]+)\/link$/);
    if (method === 'GET' && linkMatch && isMediaId(linkMatch[1]!)) {
      if (!identityId) {
        json(response, 401, { error: 'identity_required' });
        return;
      }
      if (!options.objectService) {
        json(response, 503, { error: 'object_storage_unavailable' });
        return;
      }
      const link = await options.objectService.mediaLink(linkMatch[1]!);
      if (!link) {
        json(response, 404, { error: 'media_not_found' });
        return;
      }
      json(response, 200, link);
      return;
    }
    const mediaId = last;
    // An id that is not a UUID never named a row, and must not reach the uuid
    // cast below, where Postgres would answer a client typo with a 500.
    if (!isMediaId(mediaId)) {
      json(response, 404, { error: 'media_not_found' });
      return;
    }
    // Object-storage branch: a ready object redirects to a fresh signed GET;
    // the redirect itself is never cached, so every read mints its own link.
    if (options.objectService) {
      const object = await options.objectService.readMediaObject(mediaId);
      if (object?.kind === 'redirect') {
        response.writeHead(302, {
          location: object.location!,
          'cache-control': 'private, no-store',
        });
        response.end();
        return;
      }
      if (object?.kind === 'expired') {
        json(response, 410, { error: 'media_expired', ttlHours: object.ttlHours });
        return;
      }
      if (object?.kind === 'pending') {
        json(response, 404, { error: 'media_not_found' });
        return;
      }
    }
    // No bytea fallback: every file lives in `objects`. A tombstone is
    // expired; anything else never existed for readers.
    const expired = (
      await options.database.query<{ retention_hours: number }>(
        `SELECT retention_hours FROM object_expirations WHERE id=$1`,
        [mediaId],
      )
    ).rows[0];
    json(response, expired ? 410 : 404, {
      error: expired ? 'media_expired' : 'media_not_found',
      ...(expired ? { ttlHours: Number(expired.retention_hours) } : {}),
    });
    return;
  }
  if (url.pathname.startsWith('/v1/phone/') && !identityId) {
    json(response, 401, { error: 'phone_token_required' });
    return;
  }

  const operation = async (name: Parameters<PhoneHttpOperation>[0], input: Record<string, unknown>, project?: (result: unknown) => unknown) => {
    if (['readRoomTools','readMediaMetadata','readMediaLink','readMediaPlayback'].includes(name))
      throw new PhoneOperationError(409, { error: 'phone_socket_required' });
    const result = await httpPhoneOperation(name, input, identityId!, phoneFamilies.get(request));
    if (result === undefined) { response.writeHead(204); response.end(); }
    else json(response, 200, project ? project(result) : result);
  };

  const profileVoiceMatch = url.pathname.match(
    /^\/v1\/phone\/workspaces\/([0-9a-f-]{36})\/agents\/([a-f0-9]{64})\/(voices)$/,
  );
  if (profileVoiceMatch) {
    const [, workspaceId, agentId] = profileVoiceMatch;
    if (method === 'GET')
      await operation('readAgentVoices', { workspaceId, agentId, ...(url.searchParams.has('roomId') ? { roomId: url.searchParams.get('roomId') } : {}) });
    else json(response, 405, { error: 'method_not_allowed' });
    return;
  }
  const voiceMatch = url.pathname.match(/^\/v1\/phone\/voice\/([0-9a-f-]{36})\/(current|state)$/);
  if (method === 'GET' && voiceMatch) {
    const [, id, action] = voiceMatch;
    await operation(action === 'current' ? 'voiceCurrent' : 'voiceState', {
      ...Object.fromEntries(url.searchParams), ...(action === 'current' ? { roomId: id } : { callId: id }),
    });
    return;
  }
  if (method === 'GET' && url.pathname === '/v1/phone/workspaces') {
    await operation('readWorkspaces', {}); return;
  }
  let match = url.pathname.match(/^\/v1\/phone\/workspaces\/([0-9a-f-]+)(?:\/(members|chats|search))?$/);
  if (method === 'GET' && match) {
    const [, workspaceId, action] = match;
    const query = Object.fromEntries(url.searchParams);
    if (action === 'members')
      await operation('readWorkspaceMembers', { ...query, workspaceId, offset: query.offset ? Number(query.offset) : undefined });
    else if (action === 'chats') await operation('readChats', { workspaceId });
    else if (action === 'search') await operation('searchMessages', { workspaceId, query: query.q ?? '', ...(query.before !== undefined ? { before: query.before } : {}) });
    else await operation('readWorkspace', { workspaceId });
    return;
  }
  match = url.pathname.match(/^\/v1\/phone\/workspaces\/([0-9a-f-]+)\/agents\/([0-9a-f]{64})$/);
  if (method === 'GET' && match) {
    await operation('readAgent', { workspaceId: match[1], agentId: match[2], ...(url.searchParams.has('workCursor') ? { workCursor: url.searchParams.get('workCursor') } : {}) }); return;
  }
  match = url.pathname.match(/^\/v1\/phone\/message-links\/([0-9a-f]{64})$/);
  if (method === 'GET' && match) {
    await operation('resolveMessageLink', { messageId: match[1] }); return;
  }
  const compact = wantsCompactView(request.headers[COMPACT_VIEW_HEADER]);
  match = url.pathname.match(/^\/v1\/phone\/rooms\/([0-9a-f-]+)(?:\/(history|outline|corners))?$/);
  if (match) {
    const [, roomId, action] = match;
    if (method === 'GET' && !action) {
      await operation('readRoom', { roomId }, result => compact ? compactRoomView(result as import('@beeline/api-contract/phone').RoomView) : result); return;
    }
    if (method === 'GET' && action === 'history') {
      const query = Object.fromEntries(url.searchParams);
      const parsed = query.before?.match(/^(\d+),([0-9a-f]{64})$/);
      const name = query.after !== undefined ? 'readHistoryAfter' : query.around !== undefined ? 'readHistoryAround' : 'readHistory';
      await operation(name, { roomId,
        ...(name !== 'readHistory' ? { messageId: query.after ?? query.around } :
          parsed ? { before: { createdAt: Number(parsed[1]), id: parsed[2] } } : {}),
      }, result => compact ? compactRoomHistoryView(result as RoomHistoryView) : result); return;
    }
    if (method === 'GET' && action === 'outline') {
      await operation('readHistoryOutline', { roomId, timeZone: url.searchParams.get('tz') ?? '' }); return;
    }
    if (method === 'GET' && action === 'corners') {
      await operation('readCorners', { ...Object.fromEntries(url.searchParams), roomId, archived: url.searchParams.get('archived') === '1' }); return;
    }
  }
  // Binary media uploads do not fit the socket's JSON operation envelope.
  if (method === 'POST' && url.pathname === '/v1/phone/media') {
    if (!options.objectService) {
      json(response, 503, { error: 'object_storage_unavailable' });
      return;
    }
    const raw = await bytes(request, options.mediaMaximumBytes + 1);
    const mime =
      typeof request.headers['content-type'] === 'string'
        ? request.headers['content-type']
        : 'application/octet-stream';
    const name =
      typeof request.headers['x-file-name'] === 'string'
        ? request.headers['x-file-name']
        : 'upload';
    try {
      json(
        response,
        201,
        await options.phone.uploadMedia(identityId!, raw, mime, name, options.mediaMaximumBytes),
      );
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'invalid upload';
      if (reason.includes('object storage is not configured')) {
        json(response, 503, { error: 'object_storage_unavailable' });
        return;
      }
      json(response, 400, { error: 'upload_rejected', reason });
    }
    return;
  }
  // Dictation streams audio bytes to the transcriber; control operations use the socket.
  if (method === 'POST' && url.pathname === '/v1/phone/transcriptions') {
    if (!options.speechTranscriber) {
      json(response, 503, { error: 'transcription_unavailable' });
      return;
    }
    let audio: Buffer;
    try {
      audio = await bytes(request, TRANSCRIPTION_MAXIMUM_BYTES);
    } catch {
      console.warn('[transcription] audio over the upload limit; Groq not called');
      json(response, 413, { error: 'audio_too_large' });
      return;
    }
    if (!audio.length) {
      json(response, 400, { error: 'audio_required' });
      return;
    }
    const header = (name: string) =>
      typeof request.headers[name] === 'string' ? (request.headers[name] as string) : undefined;
    let prompt: string | undefined;
    try {
      prompt = header('x-speech-prompt') && decodeURIComponent(header('x-speech-prompt')!);
    } catch {
      prompt = undefined;
    }
    try {
      const text = await options.speechTranscriber.transcribe({
        audio,
        mimeType: header('content-type') ?? 'audio/wav',
        ...(prompt ? { prompt } : {}),
        ...(header('x-speech-language') ? { language: header('x-speech-language')! } : {}),
      });
      json(response, 200, { text });
    } catch (error) {
      // The reason names only the provider status; audio and text are never logged.
      console.warn('[transcription]', error instanceof Error ? error.message : 'failed');
      json(response, 502, { error: 'transcription_failed' });
    }
    return;
  }
  match = url.pathname.match(/^\/v1\/phone\/github\/room-token\/([0-9a-f-]+)$/);
  if (method === 'GET' && match) {
    if (!options.github?.roomToken) throw new Error('GitHub room token service unavailable');
    if (!(await options.phone.canReadRoom(match[1]!, identityId!))) {
      json(response, 403, { error: 'room_access_denied' });
      return;
    }
    json(response, 200, await options.github.roomToken(identityId!, match[1]!));
    return;
  }
  match = url.pathname.match(/^\/v1\/phone\/operations\/([A-Za-z][A-Za-z0-9]+)$/);
  if (method === 'POST' && match) {
    await operation(match[1]! as Parameters<PhoneHttpOperation>[0], await body(request));
    return;
  }

  if (method === 'POST' && url.pathname === '/v1/daemon/artifacts') {
    const agentId = await daemonIdentity(request, options);
    if (!agentId) {
      await refuseDaemon(request, response, options);
      return;
    }
    void options.connectionPresence?.evidence(undefined, agentId);
    if (!options.objectService) {
      json(response, 503, { error: 'object_storage_unavailable' });
      return;
    }
    const raw = await bytes(request, ARTIFACT_MAXIMUM_BYTES + 1);
    if (raw.length > ARTIFACT_MAXIMUM_BYTES) {
      json(response, 413, { error: 'artifact_too_large', maximumBytes: ARTIFACT_MAXIMUM_BYTES });
      return;
    }
    const mime =
      typeof request.headers['content-type'] === 'string'
        ? request.headers['content-type'].split(';')[0]!.trim()
        : 'application/octet-stream';
    const title =
      typeof request.headers['x-artifact-title'] === 'string'
        ? decodeArtifactTitleHeader(request.headers['x-artifact-title'])
        : '';
    try {
      json(response, 201, await options.objectService.uploadArtifact(agentId, raw, mime, title));
    } catch (error) {
      json(response, 422, {
        error: 'artifact_rejected',
        reason: error instanceof Error ? error.message : 'invalid artifact',
      });
    }
    return;
  }
  if (method === 'POST' && url.pathname === '/v1/daemon/uploads') {
    const agentId = await daemonIdentity(request, options);
    if (!agentId) {
      await refuseDaemon(request, response, options);
      return;
    }
    void options.connectionPresence?.evidence(undefined, agentId);
    if (!options.objectService) {
      json(response, 503, { error: 'object_storage_unavailable' });
      return;
    }
    const input = await body(request);
    try {
      json(response, 201, await options.objectService.createUpload(agentId, input as never));
    } catch (error) {
      json(response, 422, {
        error: 'upload_rejected',
        reason: error instanceof Error ? error.message : 'invalid upload',
      });
    }
    return;
  }
  match = url.pathname.match(/^\/v1\/daemon\/uploads\/([0-9a-f-]+)\/finalize$/);
  if (method === 'POST' && match) {
    const agentId = await daemonIdentity(request, options);
    if (!agentId) {
      await refuseDaemon(request, response, options);
      return;
    }
    if (!options.objectService) {
      json(response, 503, { error: 'object_storage_unavailable' });
      return;
    }
    if (!isMediaId(match[1]!)) {
      json(response, 404, { error: 'object_not_found' });
      return;
    }
    try {
      json(
        response,
        200,
        await options.objectService.finalizeUpload(agentId, { objectId: match[1]! }),
      );
    } catch {
      json(response, 404, { error: 'object_not_found' });
    }
    return;
  }
  if (method === 'POST' && url.pathname === '/v1/daemon/media') {
    // Retired: the agent file-sharing path is `post_artifact` (object storage,
    // an `objects` row, a card). The bytea `media` store takes no NEW agent
    // writes; a 410 tells an un-upgraded daemon why instead of a bare 404.
    const agentId = await daemonIdentity(request, options);
    if (!agentId) {
      await refuseDaemon(request, response, options);
      return;
    }
    void options.connectionPresence?.evidence(undefined, agentId);
    json(response, 410, {
      error: 'media_store_retired',
      detail:
        'agents share files with post_artifact; the bytea media store no longer accepts agent uploads',
    });
    return;
  }
  // Error footers need fresh private context even when schema validation never
  // dispatched an operation. This authenticated read adds no operation log entry.
  if (method === 'GET' && url.pathname === '/v1/daemon/owed-mentions') {
    const agentId = await daemonIdentity(request, options);
    if (!agentId) { await refuseDaemon(request, response, options); return; }
    json(response, 200, { owedMentions: await owedMentions(options.database, agentId) });
    return;
  }
  // Supported installed helpers still use this ingress: HelperVersionGate has
  // no mandatory minimum. Keep wire translation here, sharing DaemonService.
  match = url.pathname.match(/^\/v1\/daemon\/operations\/([A-Za-z][A-Za-z0-9]+)$/);
  if (method === 'POST' && match) {
    const agentId = await daemonIdentity(request, options);
    if (!agentId) {
      await refuseDaemon(request, response, options);
      return;
    }
    const name = match[1]!;
    if (name === 'readCommandActivation') {
      json(response, 409, { error: 'activation_context_socket_required' });
      return;
    }
    if (name === 'getCornerAsk') {
      json(response, 410, { error: 'getCornerAsk is retired; use order and report' });
      return;
    }
    if (!DAEMON_OPERATION_NAMES.has(name as never)) {
      json(response, 404, { error: 'unknown_daemon_operation' });
      return;
    }
    const input = await body(request);
    const evidenceRoom =
      typeof input.roomId === 'string'
        ? input.roomId
        : typeof input.cornerId === 'string'
          ? input.cornerId
          : undefined;
    void options.connectionPresence?.evidence(evidenceRoom, agentId);
    const result = await options.daemon.execute(name as never, input as never, agentId);
    let context: { _beelineOwedMentions?: Awaited<ReturnType<typeof owedMentions>> } = {};
    // Only model tool responses need this private context. It must never turn a
    // committed operation into a failure, and never adds a daemon operation.
    if (request.headers['x-beeline-tool-result'] === '1') {
      try { context = { _beelineOwedMentions: await owedMentions(options.database, agentId) }; }
      catch { /* Keep the original tool result when its optional context is unavailable. */ }
    }
    json(response, 200, context._beelineOwedMentions ? { _beelineToolResult: result, ...context } : result);
    return;
  }
  json(response, 404, { error: 'not_found' });
}
