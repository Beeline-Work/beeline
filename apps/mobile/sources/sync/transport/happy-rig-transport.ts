/**
 * Happy-backed RigTransport — thin wrappers over existing Happy call sites.
 *
 * This is NOT a full re-plumb of the UI. It exists so:
 *  1. The interface typechecks against real Happy operations.
 *  2. The Buzz adapter lane can replace this class method-by-method.
 *
 * Ranked cut-over list: apps/mobile/BUZZ-SEAM.md
 */

import type {
    ChangedFile,
    MergeActionInput,
    MessageSubmitInput,
    PermissionDecision,
    RigTransport,
    SessionDetail,
    SessionEvent,
    SessionId,
    SessionSummary,
    WorktreeCreateInput,
} from './rig-transport';
import {
    RigTransportNotImplementedError,
    RigTransportStubbedError,
} from './rig-transport';
import {
    machineSpawnNewSession,
    sessionAbort,
    sessionAllow,
    sessionArchive,
    sessionDeny,
    sessionReadFile,
} from '@/sync/ops';
import { getGitStatusFiles } from '@/sync/gitStatusFiles';
import { createWorktree } from '@/utils/worktree';
import { storage } from '@/sync/storage';
import { sync } from '@/sync/sync';
import type { Session } from '@/sync/storageTypes';

function sessionToSummary(s: Session): SessionSummary {
    return {
        id: s.id,
        active: s.active,
        title: s.metadata?.summary?.text ?? undefined,
        updatedAt: s.updatedAt,
        createdAt: s.createdAt,
    };
}

function sessionToDetail(s: Session): SessionDetail {
    return {
        ...sessionToSummary(s),
        agentState: s.agentState,
        metadata: s.metadata,
    };
}

/**
 * Happy implementation of RigTransport.
 * Methods that have no Happy equivalent throw RigTransportNotImplementedError
 * with a pointer to the planned Buzz mapping.
 */
export class HappyRigTransport implements RigTransport {
    async sessionCreate(input: WorktreeCreateInput & { prompt?: string }): Promise<SessionDetail> {
        // Happy: machine RPC spawn-happy-session (ops.machineSpawnNewSession)
        if (!input.machineId || !input.path) {
            throw new RigTransportNotImplementedError(
                'sessionCreate',
                'Happy requires machineId + path; Buzz will open subchannel+worktree from channel scope',
            );
        }
        const result = await machineSpawnNewSession({
            machineId: input.machineId,
            directory: input.path,
        });
        if (result.type !== 'success') {
            const msg =
                result.type === 'error'
                    ? result.errorMessage
                    : result.type === 'pending'
                      ? `pending:${result.clientRequestId}`
                      : result.type === 'requestToApproveDirectoryCreation'
                        ? `approve-dir:${result.directory}`
                        : 'spawn failed';
            throw new Error(msg);
        }
        const existing = storage.getState().sessions[result.sessionId];
        if (existing) return sessionToDetail(existing);
        return {
            id: result.sessionId,
            active: true,
        };
    }

    async sessionsRead(): Promise<SessionSummary[]> {
        // Happy: GET /v1/sessions via Sync.fetchSessions → storage.sessions
        return Object.values(storage.getState().sessions).map(sessionToSummary);
    }

    async sessionRead(sessionId: SessionId): Promise<SessionDetail | null> {
        const s = storage.getState().sessions[sessionId];
        return s ? sessionToDetail(s) : null;
    }

    async sessionArchive(sessionId: SessionId): Promise<{ success: boolean; message?: string }> {
        return sessionArchive(sessionId);
    }

    async messageSubmit(input: MessageSubmitInput): Promise<void> {
        await sync.sendMessage(input.sessionId, input.text, {
            displayText: input.displayText,
            source: input.source as 'chat' | undefined,
        });
    }

    async runAbort(sessionId: SessionId): Promise<void> {
        await sessionAbort(sessionId);
    }

    sessionEventsSubscribe(
        _sessionId: SessionId,
        _handler: (event: SessionEvent) => void,
    ): () => void {
        // Happy's realtime path is Sync.subscribeToUpdates (socket.io update events)
        // and is not per-session-callback shaped. Adapter lane should wrap that.
        throw new RigTransportNotImplementedError(
            'sessionEventsSubscribe',
            'Cut over Sync.subscribeToUpdates / socket update handlers — see BUZZ-SEAM.md',
        );
    }

    async sessionEventsBackfill(
        _sessionId: SessionId,
        _opts?: { beforeSeq?: number; afterSeq?: number; limit?: number },
    ): Promise<SessionEvent[]> {
        throw new RigTransportNotImplementedError(
            'sessionEventsBackfill',
            'Cut over Sync message fetch (/v3/sessions/:id/messages) — see BUZZ-SEAM.md',
        );
    }

    async permissionRespond(
        sessionId: SessionId,
        requestId: string,
        decision: PermissionDecision,
        extras?: { mode?: string; allowedTools?: string[]; updatedInput?: Record<string, unknown> },
    ): Promise<void> {
        const mode = extras?.mode as
            | 'default'
            | 'acceptEdits'
            | 'bypassPermissions'
            | 'plan'
            | undefined;
        if (decision === 'approved' || decision === 'approved_for_session') {
            await sessionAllow(
                sessionId,
                requestId,
                mode,
                extras?.allowedTools,
                decision,
                extras?.updatedInput,
            );
            return;
        }
        await sessionDeny(
            sessionId,
            requestId,
            mode,
            extras?.allowedTools,
            decision === 'abort' ? 'abort' : 'denied',
        );
    }

    async worktreeCreate(
        input: WorktreeCreateInput,
    ): Promise<{ worktreeId: string; path: string; branch?: string }> {
        if (!input.machineId || !input.path) {
            throw new RigTransportNotImplementedError(
                'worktreeCreate',
                'Happy utils/worktree.createWorktree needs machineId + absolute path',
            );
        }
        const result = await createWorktree(input.machineId, input.path);
        if (!result.success) {
            throw new Error(result.error ?? 'worktree create failed');
        }
        return {
            worktreeId: result.worktreePath,
            path: result.worktreePath,
            branch: result.branchName,
        };
    }

    async worktreeArchive(worktreeId: string, opts?: { sessionId?: SessionId }): Promise<void> {
        // Happy removeWorktree needs machineId — not on the interface yet.
        void worktreeId;
        void opts;
        throw new RigTransportNotImplementedError(
            'worktreeArchive',
            'Happy removeWorktree(machineId, path) — map from worktreeId in Buzz adapter',
        );
    }

    async changedFileRead(sessionId: SessionId, path: string) {
        const res = await sessionReadFile(sessionId, path);
        if (!res.success || res.content === undefined) return null;
        // Happy returns base64 content from session RPC `readFile`
        return { content: res.content, isBinary: false };
    }

    async workspaceFilesRead(sessionId: SessionId): Promise<ChangedFile[]> {
        const status = await getGitStatusFiles(sessionId);
        if (!status) return [];
        return [...status.stagedFiles, ...status.unstagedFiles].map((f) => ({
            path: f.fullPath || f.filePath,
            status: f.status,
            linesAdded: f.linesAdded,
            linesRemoved: f.linesRemoved,
        }));
    }

    async changedFilesRevert(sessionId: SessionId, paths: string[]): Promise<void> {
        // Happy has no first-class revert RPC; diff UI uses sessionBash git checkout.
        void sessionId;
        void paths;
        throw new RigTransportNotImplementedError(
            'changedFilesRevert',
            'No Happy RPC — UI uses sessionBash git checkout; Buzz uses api/git',
        );
    }

    async mergeAction(_input: MergeActionInput): Promise<{ success: boolean; message?: string }> {
        // Happy has no parent-owner merge gate. Buzz: workflow approval grant.
        throw new RigTransportNotImplementedError(
            'mergeAction',
            'Buzz-only: emit workflow-approval grant (kinds 46010/46011/46012) — not in Happy',
        );
    }

    async terminalCreate(): Promise<never> {
        throw new RigTransportStubbedError('terminalCreate');
    }
    async terminalStop(): Promise<never> {
        throw new RigTransportStubbedError('terminalStop');
    }
    async terminalConnect(): Promise<never> {
        throw new RigTransportStubbedError('terminalConnect');
    }
}

let _defaultTransport: RigTransport | null = null;

/** Process-wide transport. Swap for BuzzRigTransport in the adapter lane. */
export function getRigTransport(): RigTransport {
    if (!_defaultTransport) {
        _defaultTransport = new HappyRigTransport();
    }
    return _defaultTransport;
}

export function setRigTransport(transport: RigTransport): void {
    _defaultTransport = transport;
}
