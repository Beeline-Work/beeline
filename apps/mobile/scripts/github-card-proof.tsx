import React from 'react';
// @ts-expect-error The standalone proof uses the installed react-dom runtime.
import { createRoot } from 'react-dom/client';
import { View, Text } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { RepositoryOnboardingCard } from '../sources/app/(app)/beeline/chat/RepositoryOnboardingCard';
const viewer = 'a'.repeat(64);
const card = { id:'card-one', roomId:'room', agentId:'c'.repeat(64), requesterId:viewer,
 kind:'repository' as const, canLink:true, state:'install_missing' as const, status:'open' as const,
 githubLinked:false, defaultName:'my-project', repositories:[], starters:[] };
function Proof() {
 const {theme} = useUnistyles();
 return <View style={{minHeight:'100%',backgroundColor:theme.buzz.bgBase,padding:24,paddingTop:56,gap:24}}>
 <Text style={{...theme.buzz.type.bodyStrong,color:theme.buzz.textPrimary}}>Repository connection</Text>
 <RepositoryOnboardingCard card={card} viewerId={viewer} {...{connectionError:new URLSearchParams(location.search).get('githubConnectionError') ?? undefined}} />
 <RepositoryOnboardingCard card={{...card,id:'card-two'}} viewerId={viewer} {...{connectionError:new URLSearchParams(location.search).get('githubConnectionError') ?? undefined}} />
 </View>;
}
createRoot(document.getElementById('root')!).render(<Proof />);
