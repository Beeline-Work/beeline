import { NewRoomDialog } from '@/components/buzz/NewRoomDialog';
import { RepoList } from '@/components/buzz/RepoList';
import React, { useState } from 'react';
// @ts-expect-error Standalone proof uses the installed react-dom runtime.
import { createRoot } from 'react-dom/client';
import { Text, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import SignIn from '@/app/(app)/beeline/onboarding';
import Workspace from '@/app/(app)/beeline/community';
import CreateWorkspace from '@/app/(app)/beeline/create-workspace';
import Invite from '@/app/(app)/join/[token]';
import GitHub from '@/app/(app)/beeline/github-installation';
import { RepositoryChoice } from '@/components/buzz/RepositoryChoice';
import { RepoPicker } from '@/components/buzz/RepoPicker';
import { AgentSignInCard } from '@/components/buzz/AgentSignInCard';
import { EmptyLedgerState } from '@/components/buzz/EmptyLedgerState';
import { RepositoryOnboardingCard } from '@/app/(app)/beeline/chat/RepositoryOnboardingCard';
const params = new URLSearchParams(location.search);
const screen = params.get('screen') ?? 'sign-in';
const installation = { installationId: 1, accountLogin: 'Northstar', status: 'active' } as any;
const repository = { key: 'repo', name: 'Northstar/planning', remote: 'https://github.com/Northstar/planning', defaultBranch: 'main' };
const noop = () => {};
function App() {
  const { theme } = useUnistyles();
  const [mode, setMode] = useState<any>(params.get('mode') ?? 'none');
  const [ownerMenuOpen, setOwnerMenuOpen] = useState(false);
  const [roomName,setRoomName]=useState('planning');
  const [inviteOnly,setInviteOnly]=useState(false);
  const [picked,setPicked]=useState<any>(null);
  const [pickerOpen,setPickerOpen]=useState(screen==='new-room-picker');
  const card = { id: 'card', roomId: 'room', agentId: 'agent', requesterId: 'viewer', status: 'open',
    kind: screen === 'starters' ? 'starters' : 'repository', canLink: true, defaultName: 'planning',
    githubLinked: true, installationId: 1, repositories: [{id:1, fullName:'Northstar/planning'}],
    starters: [{id:'task', title:'Build the first feature', evidence:'Start with a small, useful task.'}] } as any;
  let content;
  if (screen.startsWith('sign-in')) content = <SignIn />;
  else if (screen === 'workspace') content = <Workspace />;
  else if (screen === 'create-workspace') content = <CreateWorkspace />;
  else if (screen.startsWith('invite')) content = <Invite />;
  else if (screen === 'github') content = <GitHub />;
  else if (screen === 'repository-choice') content = <RepositoryChoice testIDPrefix="proof" busy={false} mode={mode} onChooseMode={setMode} loading={false} githubConnected={params.get('connected') !== '0'} onConnect={noop} linkRepo={repository} onOpenList={noop} activeInstallations={[installation]} selectedInstallation={installation} onSelectInstallation={noop} ownerMenuOpen={ownerMenuOpen} setOwnerMenuOpen={setOwnerMenuOpen} createName="planning" takenRepo={repository} onLinkInstead={()=>setMode('link')} />;
  else if (screen.startsWith('new-room')) content=<NewRoomDialog visible roomName={roomName} setRoomName={setRoomName} inviteOnly={inviteOnly} setInviteOnly={setInviteOnly} creatingRoom={false} createRoom={noop} onClose={noop} pendingRepo={picked} showRepoPicker={pickerOpen} handleToggleRepoPicker={()=>setPickerOpen(!pickerOpen)} handleSelectNoRepository={()=>setPicked(null)} handleSelectRepoCandidate={setPicked} repoCandidates={[repository]} repoInstallations={[installation]} repoPickerError={null} handleAddGitHubAccount={noop} />;
  else if(screen==='repo-empty') content=<RepoList candidates={[]} loading={false} currentKey={null} onSelect={noop} testIDPrefix="proof-empty" draftContext="proof" />;
  else if (screen === 'repo-picker') content = <RepoPicker candidates={[repository]} installations={[installation]} onSelect={noop} onCreateRepository={noop} onAddAccount={noop} />;
  else if (screen === 'empty-room') content = <EmptyLedgerState variant="room" name="#general" onPress={noop} starterIntro="Connect an agent, then ask it for something here." starterPrompts={[{lead:'Connect an agent', detail:'so this Room has someone to ask', onPress:noop},{lead:'Invite someone',detail:'to Northstar Lab',onPress:noop}]} />;
  else if (screen.startsWith('agent-')) content = <AgentSignInCard agentName="Jellybean" isOwner onSubmit={async()=>{throw new Error('Try a fresh code.');}} card={{agentId:'agent', ownerId:'viewer', harness: screen==='agent-key'?'pi':'codex', provider:screen==='agent-key'?'openrouter':undefined, kind:screen==='agent-key'?'api-key':'device-code', status:screen==='agent-wait'?'starting':screen==='agent-failed'?'failed':'pending', errorMessage:'Try a fresh code.', authorizeUrl:'https://example.com/activate',userCode:'ABCD-EFGH'} as any} />;
  else content = <RepositoryOnboardingCard card={card} viewerId="viewer" />;
  return <View style={{height:'100%',backgroundColor:theme.buzz.bgBase}}><View style={{flex:1,width:'100%',maxWidth:screen==='welcome'?undefined:640,alignSelf:'center'}}>{content}</View></View>;
}
createRoot(document.getElementById('root')!).render(<App />);
