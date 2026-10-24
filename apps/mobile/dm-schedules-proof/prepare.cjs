const fs = require('node:fs');
const path = require('node:path');
const chat = fs.readFileSync(path.join(__dirname, '../sources/app/(app)/beeline/chat/_chat-surface.tsx'), 'utf8');
const marker = chat.indexOf('testID="dm-actions-sheet"');
const start = chat.lastIndexOf('<HullActionSheetModal', marker);
const end = chat.indexOf('</HullActionSheetModal>', marker) + '</HullActionSheetModal>'.length;
fs.writeFileSync(path.join(__dirname, 'menu.tsx'), `// @ts-nocheck
import React from 'react';
import { View, Text } from 'react-native';
import { HullActionSheetModal, HullActionSheetRow, HullActionSheetCancel } from '../sources/components/buzz/HullActionSheet';
export default function Menu({onOpen}) {
 const displayRoomName='Ruby', dmActionsVisible=true, pushMuteWorking=false, pushMuted=false;
 const viewerIsAgent=false, roomSurface={viewer:{permissions:{send:true}}};
 const membershipError=null, styles={}, decodedId='dm-fixture', activeCommunityId='workspace-fixture';
 const setDmActionsVisible=()=>{}, togglePushMute=()=>{};
 const router={push:onOpen};
 return (${chat.slice(start,end)});
}`);
