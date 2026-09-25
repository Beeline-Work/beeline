/**
 * Typed connector adapters: one contract for lifecycle assignments,
 * requester permissions, and Workbench controls.
 *
 * A connection belongs to whoever provisioned it. Mutating actions are
 * owner-only; another requester is refused with the same access-denied
 * line the Workbench already uses. Squire and YouTube are registered
 * here; other kinds stay on their existing per-type path until they
 * register an adapter of their own.
 */
import type { ConnectorKind } from './workbench.js';

export const CONNECTOR_ADAPTER_ACTIONS = [
  'connect',
  'reconnect',
  'disconnect',
  'revoke-grants',
] as const;
export type ConnectorAdapterAction = (typeof CONNECTOR_ADAPTER_ACTIONS)[number];

export type ConnectorRequesterRole = 'owner' | 'other';

export type ConnectorAdapterStatus = 'disconnected' | 'installing' | 'connected' | 'error';

export type ConnectorAdapterAssignmentKind =
  | 'install'
  | 'uninstall'
  | 'sync'
  | 'revoke-grants'
  | 'refresh-google-grant';

export type ConnectorPermissionDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: string };

/** The Workbench's existing access-denied line. Never name the owner. */
export const CONNECTOR_ADAPTER_DENIED = 'connector not found (access denied)';

export function connectorRequesterRole(
  viewerId: string,
  ownerId: string,
): ConnectorRequesterRole {
  return viewerId === ownerId ? 'owner' : 'other';
}

export type ConnectorAdapter = {
  readonly kind: ConnectorKind;
  readonly actions: readonly ConnectorAdapterAction[];
  authorize(
    action: ConnectorAdapterAction,
    requester: ConnectorRequesterRole,
  ): ConnectorPermissionDecision;
  /** Workbench controls offered at this status to an authorized owner. */
  workbenchActions(
    status: ConnectorAdapterStatus | undefined,
  ): readonly ConnectorAdapterAction[];
  /** Helper assignment kinds derived from the row's own status. */
  assignmentKinds(status: ConnectorAdapterStatus): readonly ConnectorAdapterAssignmentKind[];
};

function ownerOnly(
  offered: readonly ConnectorAdapterAction[],
  action: ConnectorAdapterAction,
  requester: ConnectorRequesterRole,
): ConnectorPermissionDecision {
  if (!offered.includes(action) || requester !== 'owner') {
    return { allowed: false, reason: CONNECTOR_ADAPTER_DENIED };
  }
  return { allowed: true };
}

const SQUIRE_ACTIONS = [
  'connect',
  'reconnect',
  'disconnect',
  'revoke-grants',
] as const satisfies readonly ConnectorAdapterAction[];

export const SQUIRE_CONNECTOR_ADAPTER: ConnectorAdapter = {
  kind: 'trusty-squire',
  actions: SQUIRE_ACTIONS,
  authorize: (action, requester) => ownerOnly(SQUIRE_ACTIONS, action, requester),
  workbenchActions: (status) => {
    switch (status) {
      case 'installing':
        return ['disconnect'];
      case 'connected':
        return ['reconnect', 'disconnect', 'revoke-grants'];
      case 'error':
        return ['connect', 'reconnect', 'disconnect'];
      default:
        return ['connect'];
    }
  },
  assignmentKinds: (status) => {
    if (status === 'installing') return ['install'];
    if (status === 'disconnected') return ['uninstall'];
    return [];
  },
};

const YOUTUBE_ACTIONS = [
  'connect',
  'reconnect',
  'disconnect',
] as const satisfies readonly ConnectorAdapterAction[];

/**
 * YouTube shares the Google OAuth grant and has no Squire vault grants.
 * Revoke-grants is not a YouTube Workbench control.
 */
export const YOUTUBE_CONNECTOR_ADAPTER: ConnectorAdapter = {
  kind: 'google-youtube',
  actions: YOUTUBE_ACTIONS,
  authorize: (action, requester) => ownerOnly(YOUTUBE_ACTIONS, action, requester),
  workbenchActions: (status) => {
    switch (status) {
      case 'installing':
        return ['disconnect'];
      case 'connected':
        return ['reconnect', 'disconnect'];
      case 'error':
        return ['connect', 'reconnect', 'disconnect'];
      default:
        return ['connect'];
    }
  },
  assignmentKinds: (status) => {
    if (status === 'installing') return ['install'];
    if (status === 'disconnected') return ['uninstall'];
    if (status === 'connected') return ['refresh-google-grant'];
    return [];
  },
};

const COMPOSIO_ACTIONS = ['connect', 'reconnect', 'disconnect'] as const satisfies readonly ConnectorAdapterAction[];

export const COMPOSIO_CONNECTOR_ADAPTER: ConnectorAdapter = {
  kind: 'composio',
  actions: COMPOSIO_ACTIONS,
  authorize: (action, requester) => ownerOnly(COMPOSIO_ACTIONS, action, requester),
  workbenchActions: (status) => {
    switch (status) {
      case 'installing':
        return ['disconnect'];
      case 'connected':
        return ['reconnect', 'disconnect'];
      case 'error':
        return ['connect', 'reconnect', 'disconnect'];
      default:
        return ['connect'];
    }
  },
  assignmentKinds: (status) => {
    if (status === 'installing') return ['install'];
    if (status === 'disconnected') return ['uninstall'];
    return [];
  },
};

const ADAPTERS: Readonly<Partial<Record<ConnectorKind, ConnectorAdapter>>> = {
  'trusty-squire': SQUIRE_CONNECTOR_ADAPTER,
  'google-youtube': YOUTUBE_CONNECTOR_ADAPTER,
  composio: COMPOSIO_CONNECTOR_ADAPTER,
};

export function connectorAdapter(kind: string): ConnectorAdapter | undefined {
  return ADAPTERS[kind as ConnectorKind];
}

export function adaptedConnectorKinds(): readonly ConnectorKind[] {
  return ['trusty-squire', 'google-youtube', 'composio'];
}
