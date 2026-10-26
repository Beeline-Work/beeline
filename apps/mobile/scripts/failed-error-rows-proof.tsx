import React from 'react';
// @ts-expect-error Standalone browser proof uses installed React DOM.
import { createRoot } from 'react-dom/client';
import { Text, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { RoomViewHttpError } from '@beeline/buzz-client';
import { IndexRow } from '../sources/components/buzz/IndexRow';
import { SettingsRow } from '../sources/components/buzz/SettingsRow';
import { ConversationRow } from '../sources/components/buzz/ConversationRow';
import { ErrorBanner } from '../sources/components/buzz/ErrorBanner';
import { appErrorCopy, connectionErrorDescription } from '../sources/buzz/app-error-copy';
// @ts-expect-error Supplied inventory contains every contextual error surface.
import inventory from 'error-proof-inventory';
// @ts-expect-error Production JSX extracted by the proof builder.
import productionRows from 'error-proof-production-rows';

const error = new RoomViewHttpError(504, 'surface_request_timed_out');
let retries = 0;
const retry = () => { retries++; };
const rooms = ['beeline','experiments'].map((name,index) => ({room:{id:name,name,updatedAt:0},unread:index===0,cornerCount:0,waitingCornerCount:0,latestMessage:{text:'Merged changes and ready to try.',createdAt:0,author:{pubkey:'ruby',name:'Ruby',handle:'ruby'}}}));
function Proof() {
  const { theme } = useUnistyles();
  const t = theme.buzz;
  const sweep = new URLSearchParams(location.search).has('sweep');
  const names = sweep ? inventory.map((hit: {file: string; line: number}) => `${hit.file}:${hit.line}`) : ['Room list · R1', 'Members', 'Corners list', 'Workflow', 'Workflow run', 'Desktop sidebar', 'Desktop work pane', 'Workspace settings'];
  return <View style={{backgroundColor:t.bgBase, padding:16, gap:16}}>
    {names.map((name: string, i: number) => <View key={name}>
      <Text style={{...t.type.meta,color:t.textPrimary}}>{name}</Text>
      <View style={{flexDirection:'row',gap:16}}>
        {[false,true].map(after => <View key={String(after)} style={{flex:1,minWidth:0,borderWidth:1,borderColor:t.border,minHeight:140}}>
          <Text style={{...t.type.meta,color:t.textMuted,padding:8}}>{after?'AFTER':'BEFORE'}</Text>
          {sweep ? <View style={{padding:16}}>{inventory[i].tag === 'Text' ? <Text style={{...t.type.meta,color:t.diffRemoved}}>{after ? appErrorCopy(error) : String(error)}</Text> : <ErrorBanner inline title={after ? appErrorCopy(error) : String(error)} onRetry={retry} />}</View> : after
            ? i===0 ? <View style={{paddingHorizontal:t.roomList.edge}}>{productionRows[i](error,retry)}</View> : productionRows[i](error,retry)
            : i===7 ? <><SettingsRow title="Allow fix sweep" value="On" /><ErrorBanner inline title={`Could not update Allow fix sweep: ${String(new TypeError('Network request failed'))}`} /></>
            : <ErrorBanner inline title={String(error)} onRetry={retry} />}
          {!sweep && (i===0 || i===5) ? rooms.map(room => <View key={room.room.id} style={i===0 ? {marginHorizontal:t.roomList.edge,marginBottom:t.roomCard.gap,borderRadius:t.roomCard.cornerRadius,borderWidth:1,borderColor:t.border,backgroundColor:t.bgRaised,overflow:'hidden'} : {}}>
            <ConversationRow testID={`proof-room-${i}-${room.room.id}-${after}`} item={room as any} viewer="you" now={0} desktop={i===5} onPress={()=>undefined} onPin={()=>undefined} />
          </View>) : null}
        </View>)}
      </View>
    </View>)}
  </View>;
}
createRoot(document.getElementById('root')!).render(<Proof />);
setTimeout(() => {
  const row=document.querySelector('[data-testid="retry-proof"]') as HTMLElement;
  if (row) {
    row.click();
    const word=Array.from(row.querySelectorAll('*')).find(el=>el.textContent==='Retry') as HTMLElement;
    word.click();
    const bounds=row.getBoundingClientRect();
    document.getElementById('result')!.textContent=JSON.stringify({retries,left:bounds.left,title:row.textContent});
  } else document.getElementById('result')!.textContent='sweep rendered';
},500);
