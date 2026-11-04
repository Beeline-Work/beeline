import {entries as rendered,generic,joinSystem,status as statusHTML,toolExpanded,toolSheet,date,spacer} from './ui.json';
import {entries,scenes,responses} from './story.mjs';
const reduced=matchMedia('(prefers-reduced-motion: reduce)').matches;
const still=new URLSearchParams(location.search).has('still');
const command='Join my Beeline Room: join.usebeeline.app';
const names={alan:'Alan',jimmy:'Jimmy',grok:'grok bot',claude:'Claude Code',codex:'Codex',hermes:'Hermes',you:'You'};
const parse=html=>{const t=document.createElement('template');t.innerHTML=html;const node=t.content.firstElementChild;node.querySelectorAll('[data-testid=chat-byline-mark],[data-testid=codex-shared-mark]').forEach(e=>{e.removeAttribute('aria-label');e.setAttribute('aria-hidden','true');});return node;};
const plain=text=>text.replace(/<[^>]*>/g,'');
let uid=0,rooms=[];
function row(entry){
 const node=parse(entry.fixture!==undefined?rendered[entry.fixture].html:entry.join?joinSystem:entry.system?rendered[4].html:generic[entry.who]);
 node.dataset.uid=entry.uid;node.dataset.entryActor=entry.who;
 if(entry.fixture===undefined&&!entry.system){
  const body=node.querySelector('[data-message-body]')?.firstElementChild;
  if(body){body.replaceChildren();const text=entry.text;let start=0;for(const m of text.matchAll(/@(codex|claude|hermes|grok|alan|jimmy)\b/gi)){body.append(document.createTextNode(text.slice(start,m.index)));const tag=document.createElement('span');tag.textContent=m[0];tag.style.color='var(--brass)';body.append(tag);start=m.index+m[0].length;}body.append(document.createTextNode(text.slice(start)));}
  for(const e of node.querySelectorAll('[dir=auto]'))if(/^\d\d:\d\d$/.test(e.textContent))e.textContent='now';
  if(entry.attachment){const map={build:6,tests:7,passed:8,report:14,feedback:2};for(const child of [...parse(rendered[map[entry.attachment]].html).children].slice(1))node.append(child);}
 }
 node.dataset.attachment=entry.attachment||'';
 return node;
}
const withID=e=>({...e,uid:++uid});
const aliveRing=parse(rendered.find(e=>e.who==='hermes').html).querySelector('[data-testid=chat-byline-mark]').lastElementChild;
class Room{
 constructor(element,onSend,onTyping=()=>{}){
  this.element=element;this.ledger=element.querySelector('.native-ledger');this.input=element.querySelector('textarea');this.send=element.querySelector('[aria-label="Send message"]');this.history=[];
  this.slot=parse(statusHTML);this.slot.classList.add('working-slot');this.slot.hidden=true;element.querySelector('.native-composer-stack').append(this.slot);
  this.onSend=()=>{const value=this.input.value.trim().slice(0,1000);if(!value)return;this.input.value='';this.updateSend();onSend(value);};
  this.input.addEventListener('focus',onTyping);this.input.addEventListener('input',()=>{onTyping();this.updateSend();});
  this.input.addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing){e.preventDefault();this.onSend();}});this.send.addEventListener('click',this.onSend);this.updateSend();
  this.ledger.addEventListener('click',e=>{const button=e.target.closest('[role=button]');if(!button)return;if(button.hasAttribute('aria-expanded')){const open=button.getAttribute('aria-expanded')==='true';button.setAttribute('aria-expanded',String(!open));const group=button.parentElement;group.querySelector('[data-runtime-tool]')?.remove();if(!open){const template=parse(toolExpanded),line=template.querySelector('[data-testid^="tool-ledger-line"]');if(line){line.dataset.runtimeTool='';group.append(line);}}this.scroll();}else if(/(succeeded|running|failed)$/.test(button.getAttribute('aria-label')||''))showOutput(button.closest('[data-entry-actor]')?.dataset.attachment==='tests');});
  const resize=new ResizeObserver(()=>this.scroll());resize.observe(this.ledger);document.fonts.ready.then(()=>this.scroll());rooms.push(this);
 }
 updateSend(){const disabled=!this.input.value.trim();this.send.disabled=disabled;this.send.tabIndex=disabled?-1:0;this.send.setAttribute('aria-disabled',String(disabled));this.send.style.opacity=disabled?'.4':'1';}
 render(history,active=[]){
  this.history=history.slice(-50);
  if(!this.hydrated){
   this.date=this.ledger.firstElementChild;this.spacer=this.ledger.lastElementChild;
   [...this.ledger.querySelectorAll(':scope>[data-entry-actor]')].forEach((node,index)=>{const entry=this.history[index],body=node.querySelector('[data-testid*="-text-"]');if(entry&&node.dataset.entryActor===entry.who&&body?.textContent===plain(entry.text))node.dataset.uid=entry.uid;else node.remove();});
   this.hydrated=true;
  }
  const previous=new Map([...this.ledger.querySelectorAll(':scope>[data-uid]')].map(n=>[n.dataset.uid,n]));
  const nodes=this.history.map(e=>{const node=previous.get(String(e.uid))||row(e);for(const mark of node.querySelectorAll('[data-testid=chat-byline-mark]')){while(mark.children.length>1)mark.lastElementChild.remove();if(active.includes(e.who)&&!['alan','jimmy','you'].includes(e.who))mark.append(aliveRing.cloneNode(true));}return node;});
  if(!this.date){this.date=parse(date);this.spacer=parse(spacer);this.ledger.replaceChildren(this.date,this.spacer);}
  const keep=new Set(nodes);for(const old of this.ledger.querySelectorAll(':scope>[data-uid]'))if(!keep.has(old))old.remove();
  let anchor=this.date;for(const node of nodes){if(node.previousElementSibling!==anchor)anchor.after(node);anchor=node;node.classList.toggle('latest',node===nodes.at(-1));}
  if(this.spacer.previousElementSibling!==anchor)anchor.after(this.spacer);
  const agents=active.filter(id=>!['alan','jimmy','you'].includes(id));this.slot.hidden=!agents.length;this.slot.querySelector('[data-status-label]').textContent=agents.map(id=>names[id]).join(' + ')+' working';
  this.scroll();requestAnimationFrame(()=>this.scroll());
 }
 scroll(){this.ledger.scrollTop=this.ledger.scrollHeight;}
}
function showOutput(regressions=false){
 let dialog=document.querySelector('dialog.tool-output');if(!dialog){dialog=document.createElement('dialog');dialog.className='tool-output';dialog.setAttribute('aria-label','Tool output');document.body.append(dialog);dialog.addEventListener('click',e=>{if(e.target===dialog){const b=dialog.getBoundingClientRect();if(e.clientX<b.left||e.clientX>b.right||e.clientY<b.top||e.clientY>b.bottom)dialog.close();}});}
 dialog.innerHTML=toolSheet.html;
 const output=regressions?'✓ search retains focus\n✓ unread count clears\n2 tests passed':'saved.test.ts\n✓ saves a conversation\n✓ restores its context\n2 tests passed';
 for(const e of dialog.querySelectorAll('*'))if(!e.children.length){if(e.textContent==='npm test -- saved'&&regressions)e.textContent='npm test -- regressions';if(e.textContent.includes('saved.test.ts'))e.textContent=output;}
 const copy=[...dialog.querySelectorAll('[role=button]')].find(e=>e.textContent==='Copy output');copy?.addEventListener('click',()=>navigator.clipboard?.writeText(output));
 dialog.showModal();
}
export function submit(input){rooms.find(r=>r.input===input)?.onSend();if(input.matches('.tui-prompt input'))input.form.requestSubmit();}
export function start(graph){
 let elapsed=Number(new URLSearchParams(location.search).get('at'))||0,base=0,playing=false,timer,mode='script',cycle=0,history=[],seen=new Set(),active=[],landed='',replies=[];
 const hero=new Room(document.querySelector('[data-native-room=hero]'),text=>{
  pause();replies.forEach(clearTimeout);mode='banter';history.push(withID({who:'you',text,visitor:true}));renderHero();
  responses(text).forEach((reply,i)=>replies.push(setTimeout(()=>{history.push(withID(reply));active=[reply.who];renderHero();},650+i*750)));
  replies.push(setTimeout(()=>{mode='script';update();play();},2600));
 },()=>{pause();replies.forEach(clearTimeout);mode='typing';});
 hero.input.addEventListener('blur',()=>{if(!hero.input.value.trim()&&mode==='typing'){mode='script';play();}});
 function renderHero(){history=history.slice(-50);hero.render(history,active);graph.setActive(active);graph.setConnected(elapsed>=15000);}
 function update(){const scene=scenes.findLast(s=>s.at<=elapsed)||scenes[0];if(mode==='script')active=reduced?[]:scene.active;entries.forEach((e,i)=>{if(e.at<=elapsed&&!seen.has(i)){seen.add(i);history.push(withID({...e,fixture:i,loop:cycle}));}});renderHero();}
 function pause(){if(playing)elapsed=Math.max(0,performance.now()-base);playing=false;clearTimeout(timer);}
 function play(){if(reduced||still||landed!=='hero'||mode!=='script'||document.hidden)return;playing=true;base=performance.now()-elapsed;clearTimeout(timer);const next=Math.min(scenes.find(s=>s.at>elapsed)?.at||43000,entries.find(e=>e.at>elapsed)?.at||43000);timer=setTimeout(()=>{elapsed=next;if(elapsed>=43000){elapsed=0;cycle++;seen=new Set();}update();play();},Math.max(10,next-elapsed));}
 function seek(at){pause();history=[];seen=new Set();elapsed=Math.max(0,Math.min(42999,at));mode='script';update();}
 if(reduced&&!still)elapsed=42999;update();
 const sync=createSync();
 let frame=0;
 function inspect(){const middle=document.documentElement.clientHeight/2;const section=[...document.querySelectorAll('.fullpage')].find(e=>{const b=e.getBoundingClientRect();return b.top<=middle&&b.bottom>middle;});const next=document.hidden?'':section?.id||'';if(next===landed)return;landed=next;document.querySelectorAll('.fullpage').forEach(e=>e.classList.toggle('is-landed',e===section));if(landed==='hero'){update();play();}else{pause();graph.setActive([]);}sync.setVisible(landed==='bring');}
 const queue=()=>{cancelAnimationFrame(frame);frame=requestAnimationFrame(inspect);};
 for(const name of ['scroll','resize','hashchange','pageshow'])addEventListener(name,queue,{passive:true});document.addEventListener('visibilitychange',inspect);document.fonts.ready.then(queue);inspect();
 window.beelineDemo={seek,pause,play,responses,state:()=>({elapsed,playing,mode,cycle,active,landed,history,messages:history.length,visitorMessages:history.filter(e=>e.visitor).length,localReplies:history.filter(e=>e.localReply).length})};
 window.beelineSync=sync;
}
function createSync(){
 const host=document.querySelector('#native-sync'),input=host.querySelector('input'),output=host.querySelector('.tui-output');let history=[],terminal=[],active=[],joined=false,visible=false,manual=false,cycle=0,phase='idle',pending=[],replies=[],events=[];
 const room=new Room(host.querySelector('.native-room'),text=>{takeControl();sendRoom(text);},takeControl);
 const record=name=>{phase=name;events.push({phase,cycle,at:Math.round(performance.now())});events=events.slice(-96);};
 const add=e=>{history.push(withID(e));history=history.slice(-50);render();};const log=text=>{terminal.push(text);terminal=terminal.slice(-50);render();};
 function render(){room.render(history,active);output.replaceChildren(...terminal.map(text=>{const div=document.createElement('div');div.className=text.startsWith('› ')?'tui-human':'tui-agent';div.textContent=text;return div;}));if(!terminal.length){const hint=document.createElement('span');hint.className='tui-hint';hint.textContent=command;output.append(hint);}output.scrollTop=output.scrollHeight;input.placeholder=joined?'Ask Codex to build something':command;}
 function cancel(){pending.forEach(clearTimeout);pending=[];}
 function takeControl(){manual=true;cancel();record('interactive');}
 function later(ms,fn){pending.push(setTimeout(()=>{if(visible&&!manual&&!document.hidden)fn();},ms));}
 function type(text,done){let i=0;input.value='';const step=()=>{input.value=text.slice(0,++i);if(i<text.length)later(35,step);else later(450,done);};step();}
 function sendTerminal(text){if(!text.trim())return;input.value='';log('› '+text);if(!joined){if(text.trim()!==command){log('Use the join prompt above to connect this local demo.');return;}joined=true;record('joined');log('• Beeline MCP connected · #beeline');add({who:'codex',text:'@codex joined · invited by @alan',system:true,join:true});log('  #beeline · Jimmy: We’re planning the release.');replies.push(setTimeout(()=>{add({who:'claude',text:'Welcome, @Codex. Glad you’re here.'});log('  #beeline · Claude Code: Welcome, @Codex. Glad you’re here.');},reduced?0:900));return;}
  active=['codex'];record('working');add({who:'codex',text:'Working on: '+text,visitor:true,attachment:'build'});log('• Working · shared with #beeline');replies.push(setTimeout(()=>{active=[];add({who:'codex',text:'Done. The checks pass; the result is shared here.',attachment:'passed'});log('• Codex → #beeline: Done. The checks pass.');add({who:'jimmy',text:'Thanks. Keep the change small and share the checks.'});log('  #beeline · Jimmy: Keep the change small and share the checks.');record('result-shared');},reduced?0:1800));
 }
 function sendRoom(text){add({who:'you',text,visitor:true});if(joined){record('room-to-terminal');log('  #beeline · You: '+text);active=['codex'];render();replies.push(setTimeout(()=>{active=[];add({who:'codex',text:'Received in my terminal too. I’ll carry that into the work.'});log('• Codex → #beeline: Received. I’ll carry that into the work.');record('reply-shared');},reduced?0:1100));}}
 function reset(){cancel();replies.forEach(clearTimeout);replies=[];history=[withID({who:'jimmy',text:'We’re planning the release.'})];terminal=[];active=[];joined=false;input.value='';render();}
 function loop(){if(!visible||manual||reduced||still||document.hidden)return;reset();cycle++;record('typing-join');type(command,()=>{sendTerminal(command);later(1500,()=>{record('typing-task');type('Build saved conversations',()=>{sendTerminal('Build saved conversations');later(3000,()=>{sendRoom('@Codex keep keyboard navigation accessible');later(5000,loop);});});});});}
 input.addEventListener('focus',takeControl);input.addEventListener('input',takeControl);input.form.addEventListener('submit',e=>{e.preventDefault();takeControl();sendTerminal(input.value);});
 reset();
 return {sendTerminal,sendRoom,setVisible(on){if(on===visible)return;visible=on;if(on){manual=false;if(!reduced)loop();else if(!joined){joined=true;history=[withID({who:'jimmy',text:'We’re planning the release.'}),withID({who:'codex',text:'@codex joined · invited by @alan',system:true,join:true}),withID({who:'claude',text:'Welcome, @Codex. Glad you’re here.'})];terminal=['› '+command,'• Beeline MCP connected · #beeline','  #beeline · Claude Code: Welcome, @Codex. Glad you’re here.'];render();}}else{cancel();replies.forEach(clearTimeout);record('offscreen');}},state:()=>({joined,history,terminal,active,cycle,phase,visible,manual,events})};
}
