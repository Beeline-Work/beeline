import React, { useEffect, useState } from 'react';
// @ts-expect-error Standalone proof uses the installed react-dom runtime.
import { createRoot } from 'react-dom/client';
import { ScrollView, Text, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import SignIn from '@/app/(app)/beeline/onboarding';
import CreateWorkspace from '@/app/(app)/beeline/create-workspace';
import { LedgerEntry, LedgerSystemLine } from '@/components/buzz/Ledger';
import { RepositoryOnboardingCard } from '@/app/(app)/beeline/chat/RepositoryOnboardingCard';
const params = new URLSearchParams(location.search);
const screen = params.get('screen') ?? 'sign-in';
function App() {
  const { theme } = useUnistyles();
  const [stage, setStage] = useState(screen);
  const [room, setRoom] = useState<any>(null);
  (globalThis as any).__proofNavigate = setStage;
  useEffect(() => {
    if (stage !== 'general') return;
    const state = (globalThis as any).__shortFlow;
    fetch(`${state.base}/room/${state.roomId}`, {headers:{'x-proof-identity':state.identityId}})
      .then(r=>r.json()).then(setRoom);
  }, [stage]);
  return <View style={{flex:1, height:'100%',backgroundColor:theme.buzz.bgBase}}>
    {stage === 'sign-in' ? <SignIn /> : stage === 'create-workspace' ? <CreateWorkspace /> :
      <ScrollView contentContainerStyle={{padding:theme.buzz.space.md, maxWidth:760, width:'100%', alignSelf:'center'}}>
        <Text style={{...theme.buzz.type.hero,color:theme.buzz.textPrimary}}>#general</Text>
        {room?.messages?.map((message:any) => message.onboarding ?
          <RepositoryOnboardingCard key={message.id} card={message.onboarding} viewerId={(globalThis as any).__shortFlow.identityId} author={message.author} /> :
          message.presentation === "system" ? <LedgerSystemLine key={message.id} id={message.id} text={message.text} event={message.systemEvent} stamp="now" /> :
          <LedgerEntry key={message.id} itemId={message.id} bodyText={message.text} bodyTestID="beebee-hello" byline={{name:message.author.name,stamp:"now",mark:{kind:message.author.kind,seed:message.author.id,face:message.author.face}}} luminous chronological />)}
      </ScrollView>}
  </View>;
}
createRoot(document.getElementById('root')!).render(<App />);
