import type { SquireApprovalDetails } from './approval-copy.js';
import type { AppTransport, ConnectAppStatus } from './app-connections.js';
import type { AgentGrantEscalation, AgentGrantKind, AgentGrantStatus, CommandGrantScript } from './agent-grants.js';
import type { ChoiceOptionInput } from './room-choices.js';
import { TurnOutputAuthority } from './daemon-operations.js';
import { CornerInput, RoomInput, AgentInput } from './daemon-operations-daemon-operation-map.js';
import { CornerBriefDraft, CornerWatchKind, RegistryMcpManifest } from './daemon-operations-room-conversation-window.js';


export type ReviseCornerBriefInput = TurnOutputAuthority &
  CornerInput & {
    readonly reviewer?: string;
    readonly requestId: string;
    readonly roomId?: string;
    readonly expectedRevision: number;
    readonly brief: CornerBriefDraft;
  };

export type CornerResult = {
  readonly cornerId: string;
  readonly warnings?: readonly string[];
  /** The opener's merge watch, absent when the opener opted out. */
  readonly watch?: { readonly roomId: string; readonly kinds: readonly CornerWatchKind[] };
};


/** ask_choice / open_poll: a lettered preference, never a grant. */
export type ChoiceOptionArg = ChoiceOptionInput;

export type AskRoomChoiceInput = TurnOutputAuthority &
  RoomInput & {
    readonly ask?: string;
    readonly prompt: string;
    readonly constraint?: string;
    readonly options: readonly ChoiceOptionArg[];
    readonly ttlSeconds?: number;
  };

export type OpenRoomPollInput = TurnOutputAuthority &
  RoomInput & {
    readonly prompt: string;
    readonly constraint?: string;
    readonly options: readonly ChoiceOptionArg[];
    readonly ttlSeconds: number;
  };

export type AskRoomChoiceResult = {
  readonly choiceId: string;
  readonly messageId: string;
  readonly mode: 'question' | 'poll';
  readonly electorateCount: number;
  readonly closesAt?: number;
};


/** request_grant: the agent raises its hand for one kind of reach in one Room. */
export type RequestAgentGrantInput = TurnOutputAuthority &
  RoomInput & {
    readonly kind: AgentGrantKind;
    readonly target: string;
    readonly purpose: string;
    readonly touches?: string;
    readonly capabilities?: string;
    readonly reason: string;
    /** Server-bound app identity for another person's connected app. */
    readonly appId?: string;
    /** Optional lifetime in seconds; the grant expires this long after the request. */
    readonly ttlSeconds?: number;
    /**
     * For an interpreter command, the script the daemon read out of the agent's
     * checkout or scratch. The card shows it and the approval is bound to its
     * hash (C94); the server never reads the operator's filesystem itself.
     */
    readonly script?: CommandGrantScript;
  };

export type RequestAgentGrantResult = {
  readonly grantId: string;
  readonly status: AgentGrantStatus;
  /** True when yolo approved it on the spot (no card was posted). */
  readonly auto: boolean;
  /** The card message when one was posted or joined. */
  readonly messageId?: string;
  /** Server-owned placement and decision authority for a pending card. */
  readonly approval?: {
    readonly destination: 'room' | 'system-dm' | 'trusty-squire-dm' | 'wallet-dm';
    readonly authority: 'workspace-manager' | 'workspace-manager-or-agent-owner' | 'resource-owner';
  };
  /** Why yolo did not cover this ask, when it did not (C94). */
  readonly escalations?: readonly AgentGrantEscalation[];
};

/** Every live (approved or once, unexpired) grant of this agent, for the rule runner. */
export type AgentGrantListResult = {
  readonly grants: readonly {
    readonly grantId: string;
    readonly workspaceId: string;
    readonly roomId: string;
    readonly kind: AgentGrantKind;
    readonly target: string;
    readonly status: AgentGrantStatus;
    readonly requestedBy: string;
    readonly requestedByName?: string;
    readonly expiresAt?: number;
    /** The script bytes this approval was bound to, for the runner's re-check. */
    readonly script?: CommandGrantScript;
  }[];
};

/** One grant row for the agent's own inspection (`list_grants`), never authority. */
export type AgentGrantRequestView = {
  readonly grantId: string;
  /** Present when inspecting the implementer's grant as a corner reviewer. */
  readonly agentId?: string;
  readonly workspaceId: string;
  readonly roomId: string;
  readonly kind: AgentGrantKind;
  readonly target: string;
  readonly reason: string;
  readonly status: AgentGrantStatus;
  /** True when yolo approved it on the spot with no card. */
  readonly auto: boolean;
  readonly requestedBy: string;
  readonly requestedByName?: string;
  /** Absolute Unix seconds when the request was raised. */
  readonly createdAt: number;
  readonly expiresAt?: number;
};

/** Every grant this agent raised, pending and live, for inspection. */
export type AgentGrantRequestListResult = {
  readonly grants: readonly AgentGrantRequestView[];
};

/** A 'once' grant is spent by its first run. */
export type ConsumeAgentGrantInput = { readonly grantId: string };

export type AuthorizeSquireCallInput = TurnOutputAuthority & RoomInput;

export type PostSquireApprovalInput = SquireApprovalDetails & TurnOutputAuthority &
  RoomInput & {
    readonly tool: string;
    readonly title: string;
    readonly detail: string;
    readonly approvalUrl: string;
    readonly approvalId?: string;
    readonly linkKind: 'approval' | 'passkey' | 'vouch';
    /** Squire's absolute expires_at, as Unix milliseconds. */
    readonly expiresAt?: number;
    /**
     * The provider page this Squire session was driving, when the call carried
     * one. It names the exact Registry authorization attempt whose owner link
     * Squire has already relayed; nothing else is deduplicated against it.
     */
    readonly signInUrl?: string;
  };

/**
 * A Squire approval this agent asked for (`postSquireApproval`) was decided —
 * approved or denied. Posted by the helper, from a decision signal Squire
 * itself relays over the already-open task connection it kept alive for
 * exactly this wait (never polled). `requestId` is the turn that was active
 * when the approval went pending, so the server can resume that exact turn
 * (`squire-approval-decided` is a `RESUME_KINDS` member) the same way
 * `grant-decided` resumes a grant.
 */
export type PostSquireApprovalDecisionInput = RoomInput & {
  readonly requestId: string;
  readonly approvalId: string;
  readonly status: 'approved' | 'denied' | 'expired';
  readonly tool: string;
  readonly title: string;
  readonly detail: string;
};

/**
 * Squire's own structured hand-back, named field by field — never prose.
 * `google_session` is `NeedsUserLogin` (Squire's Google-session gate: no live
 * provider session at all, `resume: "connect"`). `oauth_sign_in` is Drive's
 * own mid-task hand-back when an OAuth act is stuck awaiting a human ON the
 * provider's page (`resume: "connect"` too, but for whichever provider that
 * page belongs to — Squire names none). `awaiting_human` is the OAuth
 * mid-flow observation underneath that (a 2FA/consent challenge Squire is
 * already driving); it carries no sign-in page of its own — Squire's own
 * `next_action: "operate_observe"` remains the remedy for it, so it is
 * detected and reported but produces no reconnect ceremony here.
 */
export type PostSquireLoginWallInput = TurnOutputAuthority &
  RoomInput & {
    readonly wall: 'google_session' | 'oauth_sign_in' | 'awaiting_human';
    /** Squire's own `needs_user.message` (google_session, oauth_sign_in) or
     *  `oauth.reason` (awaiting_human), verbatim. */
    readonly message: string;
  };

export type PostSquireLoginWallResult = {
  readonly id: string;
  readonly createdAt: number;
  /** False when the wall was recorded but produced no card — e.g.
   *  `awaiting_human`, or no connected Squire connector was found. */
  readonly cardPosted: boolean;
  /** The `connector_offers` row this call created or joined, present
   *  whenever one exists (whether this call posted the card or joined an
   *  open one). Stamped onto that row's `command_id` the same way
   *  `offerConnector`'s result is, so its hidden resume line reaches THIS
   *  command's turn. */
  readonly offerId?: string;
};

export type AuthorizeSquireCallResult = {
  readonly allowed: boolean;
  readonly grantId?: string;
  readonly status?: AgentGrantStatus;
  readonly messageId?: string;
};


// ── Connector offers (R5) ─────────────────────────────────────────

/**
 * What an agent may learn about the Workbench from a Room: the catalog (every
 * connector kind, its name, one-line purpose, and whether it can be offered),
 * plus what the OWNER of this helper's machine already has paired and which
 * keys they hold (names only; a vault value never crosses this wire). The
 * addressee is who woke the turn (for offers); the catalog is never theirs
 * unless they are also the owner.
 */
export type AgentWorkbenchView = {
  readonly addressee: {
    readonly identityId: string;
    readonly name: string;
    readonly handle?: string;
  };
  /** The human who owns this helper and this machine. */
  readonly owner: {
    readonly identityId: string;
    readonly name: string;
    readonly handle?: string;
  };
  readonly catalog: readonly {
    readonly connectorType: string;
    readonly name: string;
    readonly purpose: string;
    /** The Workbench can pair it today. */
    readonly available: boolean;
    /** You may offer it from this Room with offer_connector. */
    readonly offerable: boolean;
    /** Row-backed connectors only. Squire's broker report lives on machine.squire. */
    readonly paired?: {
      readonly status: 'installing' | 'connected' | 'error' | 'disconnected';
      readonly helperName: string;
      /** The pairing runs on THIS agent's machine. */
      readonly onThisMachine: boolean;
      readonly errorMessage?: string;
    };
  }[];
  /** The owner's provisioned keys, by name only. */
  readonly connections: readonly {
    readonly connectorType: string;
    readonly service: string | null;
    readonly label: string;
    readonly state: 'active' | 'error';
  }[];
  readonly registryServers: readonly {
    readonly connectorId: string;
    readonly serverName: string;
    readonly version: string;
    readonly displayName: string;
    readonly status: 'installing' | 'connected' | 'error' | 'disconnected';
    readonly websiteUrl?: string;
    readonly onThisMachine: boolean;
  }[];
  /** First-party integrations expose only connection state, never credentials. */
  readonly firstPartyIntegrations?: readonly {
    readonly key: string;
    readonly name: string;
    readonly status: 'connected' | 'not-connected' | 'broken';
  }[];
  /** The owner's apps (`connect_app`): one entry per app, whatever serves it. */
  readonly apps?: readonly {
    readonly appId: string;
    readonly appKey: string;
    readonly name: string;
    readonly transport: AppTransport;
    /** The owner explicitly selected this app, rather than an agent discovering a vault key. */
    readonly selectedByOwner?: boolean;
    readonly connectorId?: string;
    readonly connectionReference?: string;
    readonly status: ConnectAppStatus;
    readonly errorMessage?: string;
  }[];
  /** This agent's own machine, where an accepted offer would install. */
  readonly machine: { readonly machineId: string; readonly name: string;
    readonly squire?: import('./workbench.js').SquireMachineReport };
};


/** offer_connector: the agent offers ONE connector in ONE Room, with its reason. */
export type OfferConnectorInput = TurnOutputAuthority &
  RoomInput & {
    readonly connectorType: string;
    readonly reason: string;
    /** `'switch'`: ask to replace the Google account an already-connected
     *  Trusty Squire is bound to (accepting forces Squire's re-sign-in). */
    readonly intent?: 'switch';
  };

export type OfferConnectorResult = {
  readonly offerId: string;
  readonly status: 'pending' | 'accepted';
  /** The card message. */
  readonly messageId: string;
  /** True when this call joined an offer this agent already had open in the Room. */
  readonly joined: boolean;
};


// ── Connector / Squire types ───────────────────────────────────────

/** One named step in a connector install or status report. */
export type ConnectorStep = {
  readonly label: string;
  readonly status: 'pending' | 'running' | 'done' | 'failed';
  /** Human-readable failure reason, present only when status === 'failed'. */
  readonly reason?: string;
  /** The CLI command this step runs, when the helper reports one. */
  readonly command?: string;
  /** Bounded tail of the step's captured output (CLI/tool logs), streamed
   *  while the step runs so a hang is visible on the phone. */
  readonly output?: string;
};


/** Status of one connector on this helper. */
export type ConnectorStatus = {
  readonly connectorId: string;
  readonly status: 'disconnected' | 'installing' | 'connected' | 'error';
  /** Ordered installation steps; empty when disconnected or connected. */
  readonly steps: readonly ConnectorStep[];
  /** The Squire account email or handle this helper is signed in as. */
  readonly signedInAs?: string;
  /** Number of agents configured on the same helper.
   * Present when the helper answers presence queries. */
  readonly agentCount?: number;
  /** Helpers are identified by name; present when status is installing or connected. */
  readonly helperName?: string;
  /** The version of the installed trusty-squire package. */
  readonly squireVersion?: string;
  /** How the human signs in, reported by the helper (Q7: Squire tells us).
   * The app opens exactly what it is told: the streamed noVNC page URL or the
   * OAuth authorization URL. */
  readonly signIn?: ConnectorSignIn;
  /** Human-readable error when status === 'error'. */
  readonly errorMessage?: string;
};


/**
 * Where Squire's connect run says the sign-in page actually opened, read
 * verbatim from its machine-readable report — never detected here. `none`
 * means the run opened no browser at all; `unknown` means it could not say.
 */
export type ConnectorBrowserLocation =
  | { readonly kind: 'host_screen' }
  | { readonly kind: 'virtual'; readonly url: string }
  | { readonly kind: 'unreachable'; readonly reason: string }
  | { readonly kind: 'none' }
  | { readonly kind: 'unknown'; readonly reason: string };


/** The sign-in surface a connector reports while it waits for the human. */
export type ConnectorSignIn = {
  readonly method: 'streamed-page' | 'oauth';
  readonly url: string;
  /** Opaque attempt identity used only to deduplicate provider handoff. */
  readonly attemptId?: string;
  /** Where the page opened, when the connect report said. */
  readonly browserLocation?: ConnectorBrowserLocation;
};


/** Metadata about one vault entry (no secret values). */
export type VaultConnectionMeta = {
  readonly reference: string;
  readonly service: string | null;
  readonly label: string;
  readonly fieldNames: readonly string[];
  readonly allowedHosts: readonly string[];
  readonly loginHosts?: readonly string[];
  readonly faviconDomain?: string;
  readonly keyName?: string;
  readonly credentialKind?: string;
  readonly expiresAt?: number;
  readonly createdAt: number;
  readonly stale: boolean;
  readonly state: 'active' | 'error';
};


/** An egress grant bound to a credential. */
export type ConnectionGrant = {
  readonly grantId: string;
  readonly credentialRef: string;
  readonly createdAt: number;
  readonly revokedAt?: number;
  readonly revokingAt?: number;
  readonly rateLimitPerHour?: number;
  readonly spendCapUsd?: number;
};


/** One entry in a connection's audit ledger. */
export type ConnectionLedgerEntry = {
  readonly id: string;
  readonly timestamp: number;
  readonly action: string;
  readonly actor?: string;
  readonly status?: number;
  readonly bytes?: number;
  /** Anomaly flag for failed or rate-limited calls. */
  readonly anomaly?: boolean;
  readonly anomalyReason?: string;
};


/** Full detail for one connection: live metadata plus grants and ledger. */
export type ConnectionDetail = {
  readonly metadata: VaultConnectionMeta;
  /** Live grants on this credential. */
  readonly grants: readonly ConnectionGrant[];
  /** Recent ledger events (shaped ledger view). */
  readonly ledger: readonly ConnectionLedgerEntry[];
};


/**
 * What one usage event means to the human who owns the key (captain ruling
 * 2026-09-15): only approval requests (a payment, a credential read in
 * clear, a host added to a key) and vault changes made on the owner's behalf
 * reach them as a receipt DM. Ordinary use carries no class and stays on the
 * key's own Workbench record.
 */
export type ConnectionUsageEventClass = 'approval' | 'vault-change';


/** Input to postConnectionUsage: one batched usage report per agent turn. */
export type ConnectionUsageRecord = {
  readonly ref: string;
  readonly service: string | null;
  readonly operation: string;
  readonly statusCode: number;
  readonly bytes: number;
  readonly grantId?: string;
  readonly grantLabel?: string;
  /** Absent means ordinary use: recorded, never DM'd to the owner. */
  readonly eventClass?: ConnectionUsageEventClass;
};


/** The overall usage report for one agent turn. */
export type PostConnectionUsageInput = {
  readonly requestId: string;
  readonly agentId: string;
  readonly roomId?: string;
  readonly cornerId?: string;
  readonly usage: readonly ConnectionUsageRecord[];
};


// ── Connector operations ───────────────────────────────────────────

export type InstallConnectorInput = AgentInput & {
  readonly connectorId: string;
  /** Echo of the assignment's pairing generation; a stale report is ignored. */
  readonly pairingGeneration?: number;
  /** Connector-specific configuration; empty for phase 1. */
  readonly config?: Record<string, unknown>;
  /** Final install report (the completion of a `postConnectorStatus` run). */
  readonly squireVersion?: string;
  readonly signedInAs?: string;
  /**
   * The sign-in surface, written authoritatively: a completing run normally
   * omits it, and the row's stored surface is cleared with it, so no dead
   * tunnel outlives the connect that printed it.
   */
  readonly signIn?: ConnectorSignIn;
};


/**
 * Read one connector row. `connectorId` names WHICH one: a helper carries the
 * four Google tool rows beside its Squire row, and without it the answer is
 * whichever row was created first.
 */
export type GetConnectorStatusInput = AgentInput & {
  readonly connectorId?: string;
};


/**
 * Incremental helper install report: the ordered steps as they settle, posted
 * once per step transition while the helper runs an install or after a sync.
 * A `errorMessage` marks the run failed; otherwise the row stays installing
 * until `installConnector` completes it.
 */
export type PostConnectorStatusInput = AgentInput & {
  readonly connectorId: string;
  /** Echo of the assignment's pairing generation; a stale report is ignored. */
  readonly pairingGeneration?: number;
  readonly steps: readonly ConnectorStep[];
  readonly squireVersion?: string;
  readonly signedInAs?: string;
  /**
   * The sign-in surface this run printed. ABSENT means "no news" — the
   * steps-only progress reports of one run must not wipe the surface that
   * run already published. Explicit `null` is a run REPORTING that it has no
   * ceremony, which clears whatever tunnel the previous run left behind.
   */
  readonly signIn?: ConnectorSignIn | null;
  readonly errorMessage?: string;
};


/** One helper vault report (metadata only; secrets never leave the helper). */
export type PostConnectorVaultInput = AgentInput & {
  readonly connections: readonly VaultConnectionMeta[];
  /** A failed live vault read updates status without replacing stored metadata. */
  readonly errorMessage?: string;
  /** No local broker is installed. Existing cached keys remain intact. */
  readonly notAdded?: boolean;
};


export type ConnectionRefInput = { readonly ref: string };

export type ConnectorVaultListResult = {
  readonly connections: readonly VaultConnectionMeta[];
};

export type ConnectionGrantRevokeResult = {
  readonly revoked: number;
  readonly failed: number;
};


/** Connector types the Workbench can provision. */
export type ConnectorKind =
  | 'trusty-squire'
  | 'wallet'
  | 'tailscale'
  | 'google-gmail'
  | 'google-calendar'
  | 'google-drive'
  | 'google-youtube'
  | 'registry-mcp';


/** The helper's work queue (server → helper delivery). */
export type ConnectorAssignment =
  | {
      readonly kind: 'install';
      readonly connectorId: string;
      readonly connectorType: ConnectorKind;
      readonly pairingGeneration?: number;
      readonly registryServerName?: string;
      readonly registryVersion?: string;
      readonly registryManifest?: RegistryMcpManifest;
      /** Set only for a scoped in-task reconnect (never the ordinary "add"
       *  pairing): the exact provider whose session Squire's connect run
       *  should force through `--force-relogin=<provider>`. */
      readonly forceReloginProvider?: string;
    }
  | { readonly kind: 'sync'; readonly connectorId: string; readonly connectorType: ConnectorKind }
  | {
      readonly kind: 'refresh-google-grant';
      readonly connectorId: string;
      readonly connectorType: ConnectorKind;
    }
  | {
      readonly kind: 'revoke-grants';
      readonly connectorId: string;
      readonly connectorType: ConnectorKind;
      readonly reference: string;
    }
  | {
      readonly kind: 'uninstall';
      readonly connectorId: string;
      readonly connectorType: ConnectorKind;
      readonly pairingGeneration?: number;
    }
  | {
      readonly kind: 'provider-webhook';
      readonly connectorId: string;
      readonly id: string;
      readonly service: 'linear' | 'stripe';
      readonly event: string;
      readonly receiverUrl: string;
      readonly operation: 'register' | 'remove';
      readonly providerId?: string;
      readonly signingSecret?: string;
      readonly accountContext?: string;
      readonly livemode?: boolean;
    };


export type ConnectorAssignmentsResult = {
  readonly assignments: readonly ConnectorAssignment[];
};

export type DaemonActivityItem = {
  readonly kind: 'thinking' | 'tool' | 'output' | 'summary' | 'note';
  readonly title: string;
  /**
   * Durable corner narration when `kind='output'`; an earlier assistant text
   * run shown inside the steps line when `kind='note'`. Never private thought
   * text.
   */
  readonly text?: string;
  readonly operation?: string;
  readonly status?: string;
  /** Bounded, redacted tool argument summaries for the corner ledger. */
  readonly command?: string;
  readonly input?: string;
  /** Bounded first/last-line excerpt of a completed tool result. */
  readonly output?: string;
  /** The identity whose message triggered the turn this row belongs to. */
  readonly requestedBy?: { readonly pubkey: string; readonly name?: string };
  readonly files?: readonly { readonly path: string; readonly status?: string }[];
  /**
   * On a `note`: this text carries on the previous note. One text run longer
   * than a note may be is split across consecutive notes, never cut.
   */
  readonly continues?: boolean;
  readonly plan?: {
    readonly objective?: string;
    readonly items: readonly {
      readonly step: string;
      readonly status: 'pending' | 'in_progress' | 'completed';
    }[];
  };
};

export type DaemonPermissionScope =
  | {
      readonly type: 'room.create';
      readonly workspaceId: string;
      readonly roomId: string;
      readonly name: string;
      readonly visibility: 'invite-only' | 'workspace';
      readonly participantIds: readonly string[];
      readonly agentIds: readonly string[];
      readonly repository?: { readonly key: string; readonly targetBranch: string };
    }
  | {
      readonly type: 'money.spend';
      readonly currency: string;
      readonly maxMinorUnits: number;
      readonly merchant: string;
      readonly purpose: string;
      readonly connectorId: string;
    }
  | {
      readonly type: 'message.send' | 'content.publish' | 'operation.execute';
      readonly connectorId: string;
      readonly target: string;
      readonly payloadDigest: string;
    }
  | {
      readonly type: 'schedule.change';
      readonly operation: 'create' | 'update' | 'pause' | 'delete';
      readonly scheduleId: string;
      readonly revisionDigest: string;
    }
  | {
      readonly type: 'mission.control';
      readonly missionId: string;
      readonly workspaceId: string;
      readonly roomId: string;
      readonly controllerAgentId: string;
      readonly repository: { readonly key: string; readonly targetBranch: string };
      readonly cornerOperations: readonly ('open' | 'close')[];
      readonly scheduleOperations: readonly ('create' | 'update' | 'pause' | 'delete' | 'fire')[];
    };

export type DaemonAgentToolMandate = {
  readonly beneficiary: string;
  readonly action: string;
  readonly scope: DaemonPermissionScope;
  readonly expiresAt?: number;
};

export type DaemonModelConfigOption = {
  readonly id: string;
  readonly category: 'model' | 'thought_level' | 'effort' | 'reasoning_effort' | 'model_config';
  readonly currentValue?: string;
  readonly options: readonly { readonly id: string; readonly name?: string; readonly description?: string }[];
};

export type DaemonPullRequestFact = {
  readonly number: number;
  readonly url: string;
  readonly title: string;
  readonly targetBranch: string;
  readonly headSha: string;
  readonly mergeability?: 'clean' | 'dirty' | 'draft' | 'unknown' | 'other';
};
