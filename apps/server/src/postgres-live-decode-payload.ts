import { LiveNotificationPayload } from './postgres-live.js';





export function decodePayload(value: string | undefined): LiveNotificationPayload | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    if (
      typeof parsed.table !== 'string' ||
      typeof parsed.operation !== 'string' ||
      typeof parsed.roomId !== 'string'
    )
      return undefined;
    return {
      ...(Array.isArray(parsed.journalStreams)
        ? { journalStreams: parsed.journalStreams.filter((s): s is string => typeof s === 'string') } : {}),
      ...(typeof parsed.instanceId==='string' ? {instanceId:parsed.instanceId} : {}),
      ...(Number.isSafeInteger(parsed.renewedAt) ? {renewedAt:parsed.renewedAt as number} : {}),
      table: parsed.table,
      operation: parsed.operation,
      roomId: parsed.roomId,
      ...(typeof parsed.ownerId === 'string' ? { ownerId: parsed.ownerId } : {}),
      ...(typeof parsed.resourceId === 'string' ? { resourceId: parsed.resourceId } : {}),
      ...(typeof parsed.accountId==='string'&&/^[0-9]{1,20}$/.test(parsed.accountId)?{accountId:parsed.accountId}:{}),
      ...(parsed.usageOnly===true?{usageOnly:true as const}:{}),
      ...(parsed.squireReportChanged === true ? { squireReportChanged: true } : {}),
      ...(parsed.squireWorkChanged === true ? { squireWorkChanged: true } : {}),
      ...(typeof parsed.squireAddress === 'string' ? { squireAddress: parsed.squireAddress } : {}),
      ...(typeof parsed.version === 'string' ? { version: parsed.version } : {}),
      ...(typeof parsed.agentId === 'string' ? { agentId: parsed.agentId } : {}),
      ...(typeof parsed.identityId === 'string' ? { identityId: parsed.identityId } : {}),
      ...(parsed.ownerOnly === true ? { ownerOnly: true } : {}),
      ...(typeof parsed.workspaceId === 'string' ? { workspaceId: parsed.workspaceId } : {}),
      ...(typeof parsed.sourceRoomId === 'string' ? { sourceRoomId: parsed.sourceRoomId } : {}),
      ...(typeof parsed.needsYouCandidate === 'boolean'
        ? { needsYouCandidate: parsed.needsYouCandidate } : {}),
      ...(typeof parsed.messageId === 'string' ? { messageId: parsed.messageId } : {}),
      ...(typeof parsed.requestId === 'string' ? { requestId: parsed.requestId } : {}),
      ...(typeof parsed.turnStatus === 'string' ? { turnStatus: parsed.turnStatus } : {}),
      ...(typeof parsed.turnId === 'string' ? { turnId: parsed.turnId } : {}),
      ...(typeof parsed.kind === 'string' ? { kind: parsed.kind } : {}),
      ...(typeof parsed.observedAt === 'number' ? { observedAt: parsed.observedAt } : {}),
      ...(typeof parsed.epoch === 'number' ? { epoch: parsed.epoch } : {}),
      ...(typeof parsed.ownerEpoch === 'string' ? { ownerEpoch: parsed.ownerEpoch } : {}),
      ...(typeof parsed.expiresAt === 'number' ? { expiresAt: parsed.expiresAt } : {}),
      ...(typeof parsed.traceId === 'string' ? { traceId: parsed.traceId } : {}),
      ...(typeof parsed.databaseAt === 'number' ? { databaseAt: parsed.databaseAt } : {}),
      ...(typeof parsed.parentRoomId === 'string' ? { parentRoomId: parsed.parentRoomId } : {}),
      ...(typeof parsed.openedBy === 'string' ? { openedBy: parsed.openedBy } : {}),
      ...(typeof parsed.archived === 'boolean' ? { archived: parsed.archived } : {}),
      ...(typeof parsed.removed === 'boolean' ? { removed: parsed.removed } : {}),
      ...(typeof parsed.closeRequested === 'boolean'
        ? { closeRequested: parsed.closeRequested }
        : {}),
      ...(typeof parsed.cornerParentId === 'string'
        ? { cornerParentId: parsed.cornerParentId }
        : {}),
      ...(parsed.cornerTextChanged === true ? { cornerTextChanged: true } : {}),
      ...(typeof parsed.pending === 'boolean' ? { pending: parsed.pending } : {}),
      ...(parsed.released === true ? { released: true } : {}),
      ...(typeof parsed.repositoryChanged === 'boolean'
        ? { repositoryChanged: parsed.repositoryChanged } : {}),
      ...(parsed.installationId !== undefined ? { installationId: String(parsed.installationId) } : {}),
      ...(parsed.repositoryId !== undefined ? { repositoryId: String(parsed.repositoryId) } : {}),
      ...(typeof parsed.jobId === 'string' ? { jobId: parsed.jobId } : {}),
      ...(typeof parsed.dueAt === 'number' ? { dueAt: parsed.dueAt } : {}),
      ...(typeof parsed.registryState === 'string' ? { registryState: parsed.registryState } : {}),
      ...(typeof parsed.registryConnectorId === 'string' ? { registryConnectorId: parsed.registryConnectorId } : {}),
      ...(typeof parsed.registryDueAt === 'number' ? { registryDueAt: parsed.registryDueAt } : {}),
      ...(typeof parsed.releaseVersion === 'string' ? { releaseVersion: parsed.releaseVersion } : {}),
      ...(typeof parsed.releaseSha === 'string' ? { releaseSha: parsed.releaseSha } : {}),
    };
  } catch {
    return undefined;
  }
}
