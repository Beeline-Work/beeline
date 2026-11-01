import React from 'react';
// @ts-expect-error Browser proof uses installed react-dom.
import { createRoot } from 'react-dom/client';
import { Text, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { LedgerBylineView } from '../sources/components/buzz/Ledger';
import { modelChoiceLabel, modelPickerChoiceLabel } from '@beeline/api-contract/phone';
import { SettingsRow } from '../sources/components/buzz/SettingsRow';
import { ComputerSessionViewer } from '../sources/components/buzz/ComputerSession';
import { ArtifactCard } from '../sources/components/buzz/ArtifactCard';
import { TranscriptCard } from '../sources/components/buzz/TranscriptCard';
import { SlashVerbPicker } from '../sources/components/buzz/SlashVerbPicker';
import { StarPromptCard } from '../sources/components/buzz/StarPromptCard';
import { ConnectorOfferCard, SquireApprovalCard } from '../sources/app/(app)/beeline/chat/RoomMessageVariants';

const none = () => {};
const params = new URLSearchParams(location.search);
const after = params.get('state') === 'after';
const section = params.get('section') ?? 'model';
const agent = { pubkey: 'a'.repeat(64), kind: 'agent', name: 'Ruby' };
const axis = { options: [{ id: 'default', name: 'Default (recommended)', description: 'Opus' }, { id: 'opus', name: 'Opus 5.5' }] };
const model = after ? modelChoiceLabel(axis, 'default') : '';
const human = { pubkey: 'b'.repeat(64), kind: 'human', name: 'Owner' };
function Proof() {
 const { theme: { buzz } } = useUnistyles();
 const parts: Record<string, React.ReactNode> = {
  model: <><LedgerBylineView byline={{ name: 'Ruby', role: model ?? '', stamp: '21:08', mark: { seed: agent.pubkey, kind: 'agent' } }} /><SettingsRow title="Model" value={model ?? ''} /><SettingsRow title="Picker choice" value={after ? modelPickerChoiceLabel(axis, axis.options[0]!) : ''} /></>,
  viewer: <View style={{ height: 220 }}><ComputerSessionViewer session={{ id: 'proof', url: 'https://example.invalid', status: 'live', access: 'proof.9999999999999', agentId: agent.pubkey } as any} onClose={none} active={false} /></View>,
  close: <TranscriptCard tier="ask" title="Shared close control" body="Close this card." onDismiss={none} />,
  destinations: <><ArtifactCard attachment={{ kind: 'artifact', url: 'data:text/plain,proof', name: 'Label proof', title: 'Label proof', mimeType: 'text/plain', size: 5 }} /><SquireApprovalCard message={{ squireApproval: { agent, tool: 'operate_login', detail: 'Sign in to example.invalid', approvalUrl: 'https://example.invalid', linkKind: 'passkey', action: 'sign in' } } as any} viewerPubkey={human.pubkey} /></>,
  rows: <SlashVerbPicker verbs={[]} commands={[{ name: 'review', description: 'Review this corner' }]} query="" highlightedIndex={-1} onDismiss={none} onSelect={none} onSelectCommand={none} />,
  symbols: <StarPromptCard prompt={{ milestone: 3, repository: 'Beeline-Work/beeline', url: 'https://github.com/Beeline-Work/beeline' }} busy={null} onAnswer={none} />,
  signin: <ConnectorOfferCard message={{ connectorOffer: { offerId: 'proof', agent, addressee: human, status: 'connecting', intent: 'add', connectorType: 'gmail', connectorName: 'Gmail', connectorId: 'gmail-proof' } } as any} viewerIsAgent={false} viewerPubkey={human.pubkey} actionId={null} onAccept={none} onContinue={none} onOpenWorkbench={none} onDecline={none} />,
 };
 return <View style={{ backgroundColor: buzz.bgBase, padding: 16, gap: 16 }}><Text style={{ color: buzz.textPrimary, fontSize: 18 }}>{after ? 'After' : 'Before'} · {section}</Text>{parts[section]}</View>;
}
createRoot(document.getElementById('root')!).render(<Proof />);
setTimeout(() => {
 const root = document.getElementById('root')!;
 const text = root.textContent ?? '';
 const checks: Record<string, boolean> = {
  model: after ? text.includes('Opus 5.5') && text.includes('Default · Opus 5.5') : !text.includes('Opus 5.5'),
  viewer: text.includes(after ? 'Open in browser' : 'Open ↗'),
  close: text.includes('Close this card.') && (after ? !!root.querySelector('svg') : text.includes('✕')),
  destinations: text.includes(after ? 'Open in browser' : 'Open in browser ↗') && text.includes(after ? 'Use passkey' : 'Use passkey ↗'),
  rows: text.includes('Review this corner') && (after ? !!root.querySelector('svg') : text.includes('→')),
  symbols: text.includes('Star Beeline on GitHub') && (after ? !text.includes('★') : text.includes('★')),
  signin: text.includes(after ? 'Continue sign-in' : 'Continue sign-in ›'),
 };
 document.getElementById('result')!.textContent = checks[section] ? `PASS ${section}` : `FAIL ${section}: ${text}`;
}, 700);
