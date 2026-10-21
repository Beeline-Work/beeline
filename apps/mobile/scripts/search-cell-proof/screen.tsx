import React,{useState} from 'react';
import {View,Text,Pressable,LogBox} from 'react-native';
import {GestureHandlerRootView} from 'react-native-gesture-handler';
import {SafeAreaProvider} from 'react-native-safe-area-context';
import {KeyboardProvider} from 'react-native-keyboard-controller';
import {useFonts} from 'expo-font';
import {UnistylesRuntime} from 'react-native-unistyles';
import AgentProfile from '../../sources/app/(app)/beeline/agent-profile';
import Workbench from '../../sources/app/(app)/beeline/settings/workbench';
import {RoomListToolbar} from '../../sources/components/buzz/RoomListToolbar';
import {SettingsRow} from '../../sources/components/buzz/SettingsRow';
import {DirectMessagePickerSheet} from '../../sources/components/buzz/DirectMessagePickerSheet';
import {ForwardMessagePickerSheet} from '../../sources/components/buzz/ForwardMessagePickerSheet';
import {RepoList} from '../../sources/components/buzz/RepoList';
import {RepositoryChoice} from '../../sources/components/buzz/RepositoryChoice';
import {RepoPicker} from '../../sources/components/buzz/RepoPicker';
import {HullActionSheetModal,HullActionSheetCancel} from '../../sources/components/buzz/HullActionSheet';
LogBox.ignoreLogs(['Text strings must be rendered within a <Text> component.', 'VirtualizedLists should never be nested']);
export default function Proof(){
 const [loaded]=useFonts({'SpaceGrotesk-Regular':require('../../sources/assets/fonts/SpaceGrotesk-Regular.ttf'),'SpaceGrotesk-Medium':require('../../sources/assets/fonts/SpaceGrotesk-Medium.ttf'),'SpaceGrotesk-SemiBold':require('../../sources/assets/fonts/SpaceGrotesk-SemiBold.ttf'),'IBMPlexMono-Regular':require('../../sources/assets/fonts/IBMPlexMono-Regular.ttf')});
 const [page,setPage]=useState('Profile'),[query,setQuery]=useState(''),[sheet,setSheet]=useState(true),[bone,setBone]=useState(true),[ownerOpen,setOwnerOpen]=useState(true);
 if(!loaded)return null;
 const rows:any[]=['Candy','Jellybean','Speedy'].map((peerName,i)=>({peerName,peerPubkey:String(i).repeat(64),peerKind:'agent'}));
 return <GestureHandlerRootView style={{flex:1}}><SafeAreaProvider><KeyboardProvider><View style={{flex:1,backgroundColor:bone?'#F3EEE4':'#14091A',paddingTop:28}}>
 <View style={{flexDirection:'row',flexWrap:'wrap'}}>{['Profile','Connectors','Rooms','DM','Forward','Repo','New Room repos','Repository choice','Theme'].map(p=><Pressable key={p} accessibilityLabel={p} onPress={()=>{if(p==='Theme'){UnistylesRuntime.setTheme(bone?'obsidian':'bone');setBone(!bone)}else{setPage(p);setSheet(true)}}} style={{padding:8}}><Text style={{color:bone?'#171310':'#f0f0f3'}}>{p}</Text></Pressable>)}</View>
 {page==='Profile'?<AgentProfile/>:page==='Connectors'?<Workbench/>:page==='Rooms'?<View><RoomListToolbar filter="all" onFilter={()=>{}} query={query} onQuery={setQuery} searchOpen/><SettingsRow title="#beeline"/><SettingsRow title="#general"/><SettingsRow title="Viewer ↔ Jellybean"/></View>:null}
 {page==='DM'?<DirectMessagePickerSheet visible={sheet} onClose={()=>setSheet(false)} busyPubkey={null} members={rows} onMessage={()=>setSheet(false)}/>:null}
 {page==='Forward'?<ForwardMessagePickerSheet visible={sheet} onClose={()=>setSheet(false)} busyRoomId={null} error={null} targets={[{kind:'room',id:'general',label:'#general',group:'rooms'},{kind:'agent',id:'jellybean',label:'Jellybean',group:'agents'}] as any} onForward={()=>setSheet(false)}/>:null}
 {page==='Repo'?<HullActionSheetModal scrollBody={false} title="Repository" visible={sheet} onClose={()=>setSheet(false)} footer={<HullActionSheetCancel testID="proof-repo-cancel" onPress={()=>setSheet(false)}/>}><RepoPicker candidates={[{key:'repo',name:'Beeline-Work/beeline',owner:'Beeline-Work',fullName:'Beeline-Work/beeline'}] as any} currentKey="repo" onSelect={()=>setSheet(false)} onAddAccount={()=>{}}/></HullActionSheetModal>:null}
 {page==='New Room repos'?<HullActionSheetModal scrollBody={false} title="New Room · Repository" visible={sheet} onClose={()=>setSheet(false)} footer={<HullActionSheetCancel testID="proof-list-cancel" onPress={()=>setSheet(false)}/>}><RepoList draftContext="proof" testIDPrefix="proof-new-room-repos" candidates={[{key:'repo',name:'Beeline-Work/beeline'},{key:'site',name:'Beeline-Work/site'}]} currentKey="repo" loading={false} onSelect={()=>setSheet(false)}/></HullActionSheetModal>:null}
 {page==='Repository choice'?<View style={{padding:24,marginTop:200}}><RepositoryChoice testIDPrefix="proof-choice" busy={false} mode="create" onChooseMode={()=>{}} loading={false} githubConnected onConnect={()=>{}} linkRepo={null} onOpenList={()=>{}} activeInstallations={[{installationId:1,accountLogin:'Beeline-Work',status:'active'},{installationId:2,accountLogin:'viewer',status:'active'}] as any} selectedInstallation={{installationId:1,accountLogin:'Beeline-Work',status:'active'} as any} onSelectInstallation={()=>{}} ownerMenuOpen={ownerOpen} setOwnerMenuOpen={setOwnerOpen} createName="beeline" takenRepo={null} onLinkInstead={()=>{}} reserveOwnerMenuSpace/></View>:null}
 </View></KeyboardProvider></SafeAreaProvider></GestureHandlerRootView>
}
