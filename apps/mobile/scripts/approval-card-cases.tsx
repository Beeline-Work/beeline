import React from 'react';
import { GrantRequestCard, SquireApprovalCard, WritePermissionCard, TargetBranchProposalCard, ConnectorOfferCard } from '../sources/app/(app)/beeline/chat/RoomMessageVariants';
import { NeedsYouCell } from '../sources/components/buzz/NeedsYouCell';
import type { ChatDisplayMessage } from '../sources/buzz/room-view-presentation';
const noop = () => {};
export const proofAgent = { pubkey: 'b'.repeat(64), kind: 'agent' as const, name: 'Jellybean', handle: 'jellybean' };
export const proofOwner = { pubkey: 'a'.repeat(64), kind: 'human' as const, name: 'Lunchbox', handle: 'lunchboxfortwo' };
export const proofRosterAgent = { pubkey: proofAgent.pubkey, displayName: 'Jellybean', avatar: 'http://127.0.0.1:18740/v1/agent-avatars/11111111-1111-4111-8111-111111111111' };
const timestamp = 1792760000;
export const approvalCases = [
  'grant-legacy', 'grant-purpose', 'squire-key', 'squire-purchase', 'squire-login', 'squire-edit-key', 'squire-delete-key', 'squire-edit-card', 'squire-vouch', 'squire-passkey',
  'spending', 'edit-corner', 'target-branch', 'connector-add', 'connector-switch', 'connector-reconnect',
  'grant-allowed', 'grant-denied', 'squire-allowed', 'squire-denied', 'permission-allowed', 'target-denied', 'connector-allowed', 'connector-denied', 'tray',
] as const;
export type ApprovalCase = typeof approvalCases[number];
export function approvalCaseElement(name: ApprovalCase, onAction: () => void = noop) {
  const message = (data: Partial<ChatDisplayMessage>): ChatDisplayMessage => ({ id: name, text: '', timestamp, isUser: false, ...data });
  const agent = proofRosterAgent;
  if (name.startsWith('grant-')) return <GrantRequestCard agent={agent} message={message({ grantRequest: {
    agent: proofAgent, owner: proofOwner, requester: proofOwner,
    grants: [{ grantId: 'proof-grant', kind: 'command', target: 'fly deploy -a beeline-preview --with FLY_TOKEN', reason: 'Publish the preview build.',
      ...(name === 'grant-purpose' ? { purpose: 'Publish the preview build.', touches: 'Preview deployment', capabilities: 'Deploy the preview' } : {}),
      machine: 'squire', status: name === 'grant-allowed' ? 'once' : name === 'grant-denied' ? 'denied' : 'pending',
      decidedBy: proofOwner, decidedAt: timestamp + 240, requestedBy: proofOwner, roomId: 'proof-room', createdAt: timestamp, auto: false }],
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
      linkKind: name === 'squire-passkey' || name === 'squire-purchase' ? 'passkey' : name === 'squire-vouch' ? 'vouch' : 'approval', sourceRoomId: 'proof-room', sourceMessageId: 'proof-request',
      ...(name === 'squire-allowed' || name === 'squire-denied' ? { status: name === 'squire-allowed' ? 'approved' : 'denied', decidedBy: proofOwner, decidedAt: timestamp + 240 } : {}),
    } })} />;
  }
  if (name === 'spending' || name === 'edit-corner' || name === 'permission-allowed') return <WritePermissionCard agent={agent} roomName="beeline" viewerIsAgent={false} viewerPubkey={proofOwner.pubkey} viewerRole="owner" actionId={null} targetBranch="main" onDecision={onAction} onOpenCorner={onAction}
    message={message({ writePermission: { permissionId: 'proof-permission', requestId: 'proof-request', agentPubkey: proofAgent.pubkey, requesterPubkey: proofOwner.pubkey, requester: proofOwner,
      tool: name === 'spending' ? 'inject_card' : 'edit_file', repository: 'owner/repo', reason: name === 'spending' ? 'Pay for the headphones checkout you asked for.' : 'Update README.md.',
      ...(name === 'spending' ? { purpose: 'squire-spending' as const } : {}), status: name === 'permission-allowed' ? 'allowed' : 'pending', decider: proofOwner, decidedAt: timestamp + 240 } })} />;
  if (name.startsWith('target-')) return <TargetBranchProposalCard agent={agent} roomName="beeline" viewerPubkey={proofOwner.pubkey} canManageWorkspace viewerIsAgent={false} currentTargetBranch="main" actionId={null} notice={null} onConfirm={onAction} onDeny={onAction}
    message={message({ targetBranchProposal: { proposalId: 'proof-target', from: 'main', to: 'release', agentPubkey: proofAgent.pubkey, purpose: 'Ship this week’s fixes from release instead of main.',
      ...(name === 'target-denied' ? { status: 'denied', decidedBy: proofOwner, decidedAt: timestamp + 240 } : {}) } })} />;
  if (name.startsWith('connector-')) return <ConnectorOfferCard agent={agent} viewerIsAgent={false} viewerPubkey={proofOwner.pubkey} viewerRole="owner" actionId={null} onAccept={onAction} onDecline={onAction} onContinue={onAction} onOpenWorkbench={onAction}
    message={message({ connectorOffer: { offerId: 'proof-connector', agent: proofAgent, addressee: proofOwner, connectorName: 'Trusty Squire', connectorType: 'trusty-squire', reason: 'Provision the API key into its vault.', consequence: 'Sign in to sites · use vault keys', helper: { machineId: 'squire', name: 'squire' },
      status: name === 'connector-allowed' ? 'accepted' : name === 'connector-denied' ? 'denied' : name === 'connector-reconnect' ? 'connecting' : 'pending', intent: name === 'connector-switch' ? 'switch' : name === 'connector-reconnect' ? 'reconnect' : 'add', connectorId: 'proof-connector', provider: 'google', createdAt: timestamp, acceptedBy: proofOwner, acceptedAt: timestamp + 240 } })} />;
  return <NeedsYouCell desktop={false} now={timestamp * 1000 + 120000} onOpen={onAction} onDismiss={onAction} onAction={async () => onAction()}
    item={{ messageId: name, workspaceId: 'proof-workspace', roomId: 'proof-room', roomName: 'squire', roomKind: 'room', text: 'Free disk space so the Android test build can finish.', createdAt: timestamp,
      approval: { kind: 'grant', actor: 'Jellybean', ask: 'wants to run a script', subject: 'python3 cleanup.py', literal: false,
        actions: [{ kind: 'grant', label: 'No', grantId: 'proof-grant', decision: 'deny' }, { kind: 'grant', label: 'Once', grantId: 'proof-grant', decision: 'once' }, { kind: 'grant', label: 'Always', grantId: 'proof-grant', decision: 'always' }] } }} />;
}
