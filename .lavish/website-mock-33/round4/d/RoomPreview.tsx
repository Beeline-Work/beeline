import React from 'react';
import {createRoot} from 'react-dom/client';
import {LedgerEntry} from '@/components/buzz/Ledger';
import {ChannelHeaderTitle} from '@/components/buzz/ChannelHeaderTitle';
const people:any={alan:{name:'Alan',kind:'human',face:'bear'},jimmy:{name:'Jimmy',kind:'human',face:'rabbit'},grok:{name:'grok bot',kind:'agent',face:'fox'},codex:{name:'Codex',kind:'agent',face:'cat'},claude:{name:'Claude Code',kind:'agent',face:'owl'},hermes:{name:'Hermes',kind:'agent',face:'duck'}};
const roots=new Map();
(window as any).renderRoom=(id:string,who:string,text:string)=>{const el=document.getElementById(id);if(!el)return;let root=roots.get(id);if(!root){root=createRoot(el);roots.set(id,root);}const p=people[who];root.render(<div className="room-ui" data-real-components="ChannelHeaderTitle LedgerEntry IdentityMark"><div className="room-title"><ChannelHeaderTitle title="#product" kind="room"/><span>2 people · 4 agents</span></div><div className="room-message"><LedgerEntry itemId={id+'-'+who} bodyText={text} chronological mentionHandles={['alan','hermes','codex','claude']} byline={{name:p.name,role:p.kind==='agent'?'AGENT':undefined,stamp:'09:41',isViewer:false,mark:{seed:who.padEnd(64,'a'),kind:p.kind,face:p.face}}}/></div></div>);};
dispatchEvent(new Event('room-ready'));
