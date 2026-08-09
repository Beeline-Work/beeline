/**
 * RigTransport — Buzzy's client↔agent seam (spec.md Appendix).
 *
 * This is the adapter boundary for the follow-up lane that plugs Buzz
 * (channels + buzz-acp + git API) under Happy's session UI.
 *
 * Happy's existing backend remains the runtime implementation today
 * (see `createHappyRigTransport` and BUZZ-SEAM.md). Do NOT wire Buzz
 * networking in this package yet.
 *
 * Every method is channel-scoped in Buzzy (not one account). Happy is
 * account-scoped; that mismatch is the re-plumb work.
 */

export type SessionId = string;
export type ChannelId = string;
export type WorktreeId = string;

export type PermissionDecision =
    | 'approved'
    | 'approved_for_session'
    | 'denied'
    | 'abort';

export type SessionSummary = {
    id: SessionId;
    /** TLC / channel the session belongs to (Buzz). Happy leaves this unset. */
    channelId?: ChannelId;
    active: boolean;
    title?: string;
    updatedAt?: number;
    createdAt?: number;
};

export type SessionDetail = SessionSummary & {
    /** Opaque agent/run state for UI (permissions, status, path, etc.). */
    agentState?: unknown;
    metadata?: unknown;
};

export type SessionEvent =
    | { type: 'assistant_delta'; sessionId: SessionId; text: string; id?: string; seq?: number }
    | { type: 'permission_review'; sessionId: SessionId; requestId: string; tool?: string; payload?: unknown }
    | { type: 'status'; sessionId: SessionId; status: string; payload?: unknown }
    | { type: 'raw'; sessionId: SessionId; payload: unknown };

export type MessageSubmitInput = {
    sessionId: SessionId;
    text: string;
    /** Optional display text / attachments — Happy's SendMessageOptions shape. */
    displayText?: string;
    source?: string;
    attachments?: unknown[];
};

export type WorktreeCreateInput = {
    /** Parent TLC / channel. */
    channelId?: ChannelId;
    /** Repo path or remote. Happy uses machine spawn directory instead. */
    path?: string;
    branch?: string;
    machineId?: string;
};

export type ChangedFile = {
    path: string;
    status?: string;
    linesAdded?: number;
    linesRemoved?: number;
};

export type MergeActionInput = {
    /** Suspended workflow approval token (Buzz kinds 46010/46011/46012). */
    approvalToken: string;
    /** Repo + tip binding for replay protection. */
    repo?: string;
    branchTip?: string;
    sessionId?: SessionId;
    channelId?: ChannelId;
};

/**
 * MVP methods from spec.md Appendix "Happy RigTransport adapter".
 * Terminal methods are explicit stubs (no live PTY on Buzz).
 */
export interface RigTransport {
    // --- Sessions ---
    sessionCreate(input: WorktreeCreateInput & { prompt?: string }): Promise<SessionDetail>;
    sessionsRead(scope?: { channelId?: ChannelId }): Promise<SessionSummary[]>;
    sessionRead(sessionId: SessionId): Promise<SessionDetail | null>;
    sessionArchive(sessionId: SessionId): Promise<{ success: boolean; message?: string }>;

    // --- Messaging ---
    messageSubmit(input: MessageSubmitInput): Promise<void>;
    runAbort(sessionId: SessionId): Promise<void>;

    // --- Realtime + permissions ---
    sessionEventsSubscribe(
        sessionId: SessionId,
        handler: (event: SessionEvent) => void,
    ): () => void;
    sessionEventsBackfill(
        sessionId: SessionId,
        opts?: { beforeSeq?: number; afterSeq?: number; limit?: number },
    ): Promise<SessionEvent[]>;
    permissionRespond(
        sessionId: SessionId,
        requestId: string,
        decision: PermissionDecision,
        extras?: { mode?: string; allowedTools?: string[]; updatedInput?: Record<string, unknown> },
    ): Promise<void>;

    // --- Worktrees (edit-mode / subchannel open) ---
    worktreeCreate(input: WorktreeCreateInput): Promise<{ worktreeId: WorktreeId; path: string; branch?: string }>;
    worktreeArchive(worktreeId: WorktreeId, opts?: { sessionId?: SessionId }): Promise<void>;

    // --- Files (diff view) ---
    changedFileRead(sessionId: SessionId, path: string): Promise<{ content: string; isBinary?: boolean } | null>;
    workspaceFilesRead(sessionId: SessionId): Promise<ChangedFile[]>;
    changedFilesRevert(sessionId: SessionId, paths: string[]): Promise<void>;

    // --- Merge (parent-owner approve) ---
    mergeAction(input: MergeActionInput): Promise<{ success: boolean; message?: string }>;

    // --- Terminals: STUB (hide UI; no live PTY) ---
    terminalCreate(_opts?: unknown): Promise<never>;
    terminalStop(_id: string): Promise<never>;
    terminalConnect(_id: string): Promise<never>;
}

/** Error thrown by stubbed / not-yet-adapted methods. */
export class RigTransportNotImplementedError extends Error {
    constructor(public readonly method: string, detail?: string) {
        super(
            detail
                ? `RigTransport.${method} not implemented: ${detail}`
                : `RigTransport.${method} not implemented (Buzz adapter pending — see BUZZ-SEAM.md)`,
        );
        this.name = 'RigTransportNotImplementedError';
    }
}

export class RigTransportStubbedError extends Error {
    constructor(public readonly method: string) {
        super(
            `RigTransport.${method} is stubbed for Buzzy (no live PTY; terminal UI hidden via BUZZY_FLAGS.hideTerminalUI)`,
        );
        this.name = 'RigTransportStubbedError';
    }
}
