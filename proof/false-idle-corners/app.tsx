import React from 'react';
import { createRoot } from 'react-dom/client';
import { RoomCornersList } from '../../apps/mobile/sources/components/buzz/RoomCornersList';
import { beelineThemes } from '../../apps/mobile/sources/buzz/groknight';
import seed from './seed.json';
const theme = beelineThemes[new URLSearchParams(location.search).get('theme') === 'bone' ? 'bone' : 'obsidian'];
document.body.style.background = theme.bgBase;
createRoot(document.getElementById('root')!).render(<main style={{maxWidth:1000,margin:'40px auto',color:theme.textPrimary,fontFamily:'SpaceGrotesk-Regular'}}>
  <h1 style={{fontWeight:500}}>Room · False idle corners</h1>
  <RoomCornersList corners={seed.corners as any} parentRoomName="Room" parentRoomId={seed.roomId} desktop />
</main>);
