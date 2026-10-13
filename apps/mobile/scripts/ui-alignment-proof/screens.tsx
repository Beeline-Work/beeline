import WorkflowScreen from '@/app/(app)/beeline/workflow';
import ConnectionScreen from '@/app/(app)/beeline/settings/workbench/connection';
import ServiceScreen from '@/app/(app)/beeline/settings/workbench/service';
import React from 'react';
// @ts-expect-error react-dom/client has no declarations in this workspace.
import {createRoot} from 'react-dom/client';
import {View,Text} from 'react-native';
import {theme} from './unistyles';
import {NewCornerDialog} from '@/components/buzz/NewCornerDialog';
import {CreatePollSheet} from '@/components/buzz/CreatePollSheet';
import {FacePickerSheet} from '@/components/buzz/FacePickerSheet';
import {DirectMessagePickerSheet} from '@/components/buzz/DirectMessagePickerSheet';
import {NewRoomDialog} from '@/components/buzz/NewRoomDialog';
import {RoomSavedCopyNotice} from '@/components/buzz/RoomSavedCopyNotice';
import {MessageSearchResults} from '@/components/buzz/MessageSearchResults';
import {HullDialog} from '@/components/buzz/HullDialog';
import {ServiceMark} from '@/components/buzz/ServiceMark';
import {SettingsRow} from '@/components/buzz/SettingsRow';
import {ProfileActions} from '@/components/buzz/ProfileActions';
import CreateWorkspace from '@/app/(app)/beeline/create-workspace';
const q=new URLSearchParams(location.search),role=q.get('role')??'confirm',b=theme.buzz,nop=()=>{};
const members=[{peerPubkey:'a'.repeat(64),peerName:'Alex Rivera',peerKind:'person',face:'fox'},{peerPubkey:'b'.repeat(64),peerName:'Jamie Chen',peerKind:'person',face:'owl'}] as any;
function Scene(){
 if(role==='confirm')return <NewCornerDialog visible title="Launch planning" setTitle={nop} creating={false} onCreate={nop} onClose={nop}/>;
 if(role==='destructive')return <ConnectionScreen/>;
 if(role==='retry')return <WorkflowScreen/>;
 if(role==='dismissal')return q.get('screen')==='face'?<FacePickerSheet visible seed="proof" face="fox" onFaceChange={nop} onSave={async()=>{}} onClose={nop}/>:<CreatePollSheet visible busy={false} onClose={nop} onCreate={async()=>true}/>;
 if(role==='field')return <CreateWorkspace/>;
 if(role==='member'||role==='header')return <DirectMessagePickerSheet visible busyPubkey={null} members={members} onClose={nop} onMessage={nop}/>;
 if(role==='service')return <ServiceScreen/>;
 if(role==='sizes')return <NewRoomDialog visible roomName="release-planning" setRoomName={nop} inviteOnly={false} setInviteOnly={nop} creatingRoom={false} createRoom={nop} onClose={nop} pendingRepo={null} showRepoPicker={false} handleToggleRepoPicker={nop} handleSelectNoRepository={nop} handleSelectRepoCandidate={nop} repoCandidates={[]} repoInstallations={[]} repoPickerError={null}/>;
 return null;
}
document.documentElement.style.background=b.bgBase;document.body.style.margin='0';
createRoot(document.getElementById('root')!).render(<View style={{height:844,width:390,backgroundColor:b.bgBase}}><Scene/></View>);
