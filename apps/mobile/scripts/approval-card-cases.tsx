import React from 'react';
import { GrantRequestCard, SquireApprovalCard, WritePermissionCard, TargetBranchProposalCard, ConnectorOfferCard } from '../sources/app/(app)/beeline/chat/RoomMessageVariants';
import { NeedsYouCell } from '../sources/components/buzz/NeedsYouCell';
import { displayRoomMessage, type ChatDisplayMessage } from '../sources/buzz/room-view-presentation';
import { readRoomViewMessage } from '@beeline/api-contract/phone';
const noop = () => {};
export const proofAgent = { pubkey: 'b'.repeat(64), kind: 'agent' as const, name: 'Jellybean', handle: 'jellybean' };
export const proofOwner = { pubkey: 'a'.repeat(64), kind: 'human' as const, name: 'Lunchbox', handle: 'lunchboxfortwo' };
export const proofRosterAgent = { pubkey: proofAgent.pubkey, displayName: 'Jellybean', avatar: 'http://127.0.0.1:18740/v1/agent-avatars/11111111-1111-4111-8111-111111111111' };
const timestamp = 1792760000;
export const approvalCases = [
  'grant-legacy', 'grant-purpose', 'squire-key', 'squire-purchase', 'squire-login', 'squire-edit-key', 'squire-delete-key', 'squire-edit-card', 'squire-vouch', 'squire-passkey',
  'spending', 'edit-corner', 'target-branch', 'connector-add', 'connector-switch', 'connector-reconnect',
  'grant-allowed', 'grant-always', 'grant-denied', 'squire-allowed', 'squire-denied', 'squire-expired', 'permission-allowed', 'target-denied', 'connector-allowed', 'connector-denied', 'tray', 'tray-write', 'tray-connector', 'tray-squire', 'tray-legacy',
] as const;
const parsedApprovalStates = {
  'grant-legacy': ['pending', 'once', 'always', 'denied'],
  'grant-purpose': ['pending', 'once', 'always', 'denied'],
  'squire-key': ['pending', 'allowed', 'denied', 'expired'],
  'squire-purchase': ['pending', 'allowed', 'denied', 'expired'],
  'squire-login': ['pending', 'allowed', 'denied', 'expired'],
  'squire-edit-key': ['pending', 'allowed', 'denied', 'expired'],
  'squire-delete-key': ['pending', 'allowed', 'denied', 'expired'],
  'squire-edit-card': ['pending', 'allowed', 'denied', 'expired'],
  'squire-vouch': ['pending', 'allowed', 'denied', 'expired'],
  'squire-passkey': ['pending', 'allowed', 'denied', 'expired'],
  spending: ['pending', 'allowed', 'denied', 'expired', 'failed'],
  'edit-corner': ['pending', 'allowed', 'denied', 'expired', 'failed'],
  'target-branch': ['pending', 'allowed', 'denied'],
  'connector-add': ['pending', 'allowed', 'denied'],
  'connector-switch': ['pending', 'allowed', 'denied'],
  'connector-reconnect': ['pending', 'allowed', 'denied'],
} as const;
export const parsedApprovalCases = Object.entries(parsedApprovalStates).flatMap(([kind, states]) => states.map(state => `${kind}--${state}`));
export type ApprovalCase = typeof approvalCases[number] | `${keyof typeof parsedApprovalStates}--${string}`;
export function approvalCaseElement(caseName: ApprovalCase, onAction: () => void = noop) {
  const [name = '', state] = caseName.split('--');
  const message = (data: Partial<ChatDisplayMessage>): ChatDisplayMessage => {
    const permission = data.writePermission;
    const target = data.targetBranchProposal;
    const parsed = readRoomViewMessage({ id: 'c'.repeat(64), text: '', createdAt: timestamp,
      author: proofAgent, presentation: 'card', squireApproval: data.squireApproval,
      grantRequest: data.grantRequest, connectorOffer: data.connectorOffer,
      ...(permission ? { permission: { ...permission, agent: proofAgent, requester: proofOwner } } : {}),
      ...(target ? { targetBranch: { ...target, agent: proofAgent, requester: proofOwner } } : {}),
    });
    if (!parsed) throw new Error(`Invalid approval proof payload: ${name}`);
    return displayRoomMessage(parsed, proofOwner.pubkey);
  };
  const agent = proofRosterAgent;
  if (name.startsWith('grant-')) return <GrantRequestCard agent={agent} message={message({ grantRequest: {
    agent: proofAgent, owner: proofOwner, requester: proofOwner,
    grants: [{ grantId: 'proof-grant', kind: 'command', target: 'fly deploy -a beeline-preview --with FLY_TOKEN', reason: 'Publish the preview build.',
      ...(name === 'grant-purpose' ? { purpose: 'Publish the preview build.', touches: 'Preview deployment', capabilities: 'Deploy the preview' } : {}),
      machine: 'squire', status: state ? state === 'always' ? 'approved' : state === 'once' ? 'once' : state === 'denied' ? 'denied' : 'pending' : name === 'grant-allowed' ? 'once' : name === 'grant-always' ? 'approved' : name === 'grant-denied' ? 'denied' : 'pending',
      decidedBy: proofOwner, decidedAt: timestamp + 240, requestedBy: proofOwner, roomId: '11111111-1111-4111-8111-111111111111', createdAt: timestamp, auto: false }],
  } })} viewerIsAgent={false} viewerPubkey={proofOwner.pubkey} viewerRole="owner" actionId={null} onDecision={onAction} />;
  if (name.startsWith('squire-')) {
    const tool = name === 'squire-purchase' ? 'inject_card' : name === 'squire-login' || name === 'squire-passkey' || name === 'squire-vouch' ? 'operate_login' : name === 'squire-edit-key' ? 'edit_credential' : name === 'squire-delete-key' ? 'delete_credential' : name === 'squire-edit-card' ? 'edit_payment_card' : 'fetch_credential';
    const action = tool === 'inject_card' ? 'buy Headphones' : tool === 'operate_login' ? 'sign in to Play Console' : tool === 'edit_credential' ? 'edit a key' : tool === 'delete_credential' ? 'delete a key' : tool === 'edit_payment_card' ? 'edit a card' : 'reveal a key';
    return <SquireApprovalCard agent={agent} viewerPubkey={proofOwner.pubkey} onOpenSource={onAction} message={message({ squireApproval: {
      agent: proofAgent, owner: proofOwner, tool, title: 'Approval', detail: 'Reveal test credential', action,
      reason: tool === 'inject_card' ? 'Replace the broken studio headphones you asked for, at the price you set.' : tool === 'operate_login' ? 'Re-save the reports permission so Android installs can be counted.' : 'Sign in the Fly command-line tool for this one deploy.',
      facts: tool === 'inject_card' ? [{ label: 'From', value: 'Acme' }, { label: 'Amount', value: '199.00 USD' }, { label: 'Card', value: 'Saved card' }]
        : tool === 'operate_login' ? [{ label: 'Site', value: 'play.google.com' }, { label: 'Login', value: 'Saved Google login' }, { label: 'Can', value: 'Fill the saved password' }]
        : [{ label: tool === 'edit_payment_card' ? 'Card' : 'Key', value: 'Fly · org-deploy' }, { label: 'Goes to', value: '@jellybean, once' }, { label: 'Can', value: tool === 'fetch_credential' ? 'Read the key value' : action }],
      ...(tool === 'fetch_credential' ? { reference: 'vault://proof-owner/proof-service/proof-key' } : {}),
      approvalUrl: 'https://approve.example.test/proof', approvalId: name,
      linkKind: name === 'squire-passkey' || name === 'squire-purchase' ? 'passkey' : name === 'squire-vouch' ? 'vouch' : 'approval', sourceRoomId: '11111111-1111-4111-8111-111111111111', sourceMessageId: 'd'.repeat(64),
      ...(state && state !== 'pending' ? { status: state === 'allowed' ? 'approved' as const : state === 'expired' ? 'expired' as const : 'denied' as const, decidedAt: timestamp + 240 } : name === 'squire-allowed' || name === 'squire-denied' || name === 'squire-expired' ? { status: name === 'squire-allowed' ? 'approved' as const : name === 'squire-expired' ? 'expired' as const : 'denied' as const, decidedAt: timestamp + 240 } : {}),
    } })} />;
  }
  if (name === 'spending' || name === 'edit-corner' || name === 'permission-allowed') return <WritePermissionCard agent={agent} roomName="beeline" viewerIsAgent={false} viewerPubkey={proofOwner.pubkey} viewerRole="owner" actionId={null} targetBranch="main" onDecision={onAction} onOpenCorner={onAction}
    message={message({ writePermission: { permissionId: 'proof-permission', requestId: 'proof-request', agentPubkey: proofAgent.pubkey, requesterPubkey: proofOwner.pubkey, requester: proofOwner,
      tool: name === 'spending' ? 'inject_card' : 'edit_file', repository: 'owner/repo', reason: name === 'spending' ? 'Pay for the headphones checkout you asked for.' : 'Update README.md.',
      ...(name === 'spending' ? { purpose: 'squire-spending' as const } : {}), status: state === 'allowed' || state === 'denied' || state === 'expired' || state === 'failed' ? state : name === 'permission-allowed' ? 'allowed' : 'pending', decider: proofOwner, decidedAt: timestamp + 240 } })} />;
  if (name.startsWith('target-')) return <TargetBranchProposalCard agent={agent} roomName="beeline" viewerPubkey={proofOwner.pubkey} canManageWorkspace viewerIsAgent={false} currentTargetBranch="main" actionId={null} notice={null} onConfirm={onAction} onDeny={onAction}
    message={message({ targetBranchProposal: { proposalId: 'proof-target', from: 'main', to: 'release', agentPubkey: proofAgent.pubkey, purpose: 'Ship this week’s fixes from release instead of main.',
      ...(state === 'allowed' || state === 'denied' ? { status: state, decidedBy: proofOwner, decidedAt: timestamp + 240 } : name === 'target-denied' ? { status: 'denied' as const, decidedBy: proofOwner, decidedAt: timestamp + 240 } : {}) } })} />;
  if (name.startsWith('connector-')) return <ConnectorOfferCard agent={agent} viewerIsAgent={false} viewerPubkey={proofOwner.pubkey} viewerRole="owner" actionId={null} onAccept={onAction} onDecline={onAction} onContinue={onAction} onOpenWorkbench={onAction}
    message={message({ connectorOffer: { offerId: '22222222-2222-4222-8222-222222222222', agent: proofAgent, addressee: proofOwner, connectorName: 'Trusty Squire', connectorType: 'trusty-squire', reason: 'Provision the API key into its vault.', consequence: 'Sign in to sites · use vault keys', helper: { machineId: 'squire', name: 'squire' },
      status: state ? state === 'allowed' ? 'accepted' : state === 'denied' ? 'denied' : 'pending' : name === 'connector-allowed' ? 'accepted' : name === 'connector-denied' ? 'denied' : name === 'connector-reconnect' ? 'connecting' : 'pending', intent: name === 'connector-switch' ? 'switch' : name === 'connector-reconnect' ? 'reconnect' : 'add', connectorId: 'proof-connector', provider: 'google', createdAt: timestamp, acceptedBy: proofOwner, acceptedAt: timestamp + 240 } })} />;
  const tray = name === 'tray-write'
    ? { kind: 'write-access' as const, ask: 'wants to open an edit corner', subject: 'owner/repo', reason: 'Update README.md.' }
    : name === 'tray-connector'
      ? { kind: 'connector' as const, ask: 'wants to add', subject: 'Trusty Squire', reason: 'Provision the API key into its vault.' }
      : name === 'tray-squire'
        ? { kind: 'squire' as const, ask: 'wants to', subject: 'reveal a key', reason: 'Sign in the Fly command-line tool for this deploy.' }
        : { kind: 'grant' as const, ask: 'wants to run a script', subject: 'python3 cleanup.py', reason: 'Free disk space so the Android test build can finish.' };
  return <NeedsYouCell desktop={false} now={timestamp * 1000 + 120000} onOpen={onAction} onDismiss={onAction} onAction={async () => onAction()}
    item={{ messageId: name, workspaceId: 'proof-workspace', roomId: 'proof-room', roomName: 'squire', roomKind: 'room', text: name === 'tray-legacy' ? tray.reason : tray.subject, createdAt: timestamp,
      approval: { kind: tray.kind, actor: 'Jellybean', ask: tray.ask, subject: tray.subject, detail: tray.reason, literal: tray.kind === 'grant',
        actions: tray.kind === 'grant' ? [{ kind: 'grant', label: 'No', grantId: 'proof-grant', decision: 'deny' }, { kind: 'grant', label: 'Once', grantId: 'proof-grant', decision: 'once' }, { kind: 'grant', label: 'Always', grantId: 'proof-grant', decision: 'always' }]
          : [{ kind: 'external', label: 'Review ↗', url: 'https://approve.example.test/proof' }] } }} />;
}
