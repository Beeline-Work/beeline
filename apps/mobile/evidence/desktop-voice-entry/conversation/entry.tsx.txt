import React, {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {ConversationComposer} from '../../sources/components/buzz/ConversationComposer';
import {useVoiceCall} from '../../sources/buzz/use-voice-call';
function Proof() {
  const voice=useVoiceCall(window.__proof.roomId,true);
  const [text,setText]=useState('');
  window.__state={call:voice.call?.id,connecting:voice.connecting,error:voice.error,target:voice.target,speaker:voice.speaker};
  return <div style={{width:1000,margin:24}}><ConversationComposer voice={voice} value={text} height={26} focused={false} disabled={false}
  onChangeText={setText} onBlur={()=>{}} onFocus={()=>{}} onKeyPress={()=>{}} onSend={()=>{}} onContentSizeChange={()=>{}} /></div>;
}
createRoot(document.getElementById('root')).render(<Proof/>);
