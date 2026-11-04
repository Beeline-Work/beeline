import './context-art.mjs';
import {selectPlatform} from '../desktop-download.mjs';
import {initializeGraph} from './graph.mjs';
const names={ios:'iOS',android:'Android',macos:'Mac',windows:'Windows',linux:'Linux'};
const detected=selectPlatform({userAgent:navigator.userAgent,platform:navigator.platform,maxTouchPoints:navigator.maxTouchPoints,uaDataPlatform:navigator.userAgentData?.platform});
for(const group of document.querySelectorAll('.smart-download')){
 const primary=group.querySelector('[data-primary-download]'),toggle=group.querySelector('.other-platforms'),list=group.querySelector('.other-platform-list'),destination=group.querySelector('[data-os="'+detected+'"]');
 if(destination){primary.href=destination.href;primary.textContent='Download for '+names[detected];primary.dataset.platform=detected;destination.hidden=true;}
 else{primary.textContent='Choose your platform';primary.removeAttribute('href');primary.setAttribute('role','button');primary.tabIndex=0;primary.onclick=()=>toggle.click();primary.onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();toggle.click();}};}
 toggle.onclick=()=>{const open=toggle.getAttribute('aria-expanded')==='true';toggle.setAttribute('aria-expanded',String(!open));list.hidden=open;};
 group.addEventListener('keydown',e=>{if(e.key==='Escape'){list.hidden=true;toggle.setAttribute('aria-expanded','false');toggle.focus();}});
}
// Preserve existing download attribution after the detected controls are set up.
import('../x-attribution.js');
const graph=initializeGraph();let ready,initialized=false;
const load=()=>ready??=(import('./demo.js?v=feature-shipping').then(m=>{m.start(graph);initialized=true;return m;}));
const idle=window.requestIdleCallback||((callback)=>setTimeout(callback,0));idle(load,{timeout:1200});
for(const event of ['focusin','pointerdown'])document.addEventListener(event,e=>{if(e.target.closest('.native-room,.codex-tui'))void load();},{capture:true});
document.addEventListener('keydown',e=>{if(!initialized&&e.key==='Enter'&&e.target.matches('.native-room textarea,.codex-tui input')){e.preventDefault();load().then(m=>m.submit(e.target));}},{capture:true});
window.beelineReady=()=>load();

document.addEventListener('click',e=>{const button=e.target.closest('[aria-label="Send message"]');if(!initialized&&button){e.preventDefault();const input=button.closest('.native-room').querySelector('textarea');load().then(m=>m.submit(input));}},{capture:true});

// Keyboard viewport changes must not resize snap sections beneath a composer.
let keyboardLayout, releaseKeyboard;
const composer=element=>element?.matches?.('.native-room textarea,.codex-tui input');
function restoreKeyboardLayout(){
 if(!keyboardLayout)return;
 for(const [element,height,minHeight] of keyboardLayout.sections){element.style.height=height;element.style.minHeight=minHeight;}
 keyboardLayout.stage.style.setProperty('--phone-transcript-height',keyboardLayout.transcript);
 document.documentElement.classList.remove('composing');keyboardLayout=null;
}
document.addEventListener('focusin',event=>{
 if(!composer(event.target))return;
 clearTimeout(releaseKeyboard);
 if(keyboardLayout||!matchMedia('(max-width:760px)').matches)return;
 const stage=document.querySelector('#stage');
 keyboardLayout={stage,transcript:stage.style.getPropertyValue('--phone-transcript-height'),sections:[...document.querySelectorAll('.fullpage')].map(element=>{
  const previous=[element,element.style.height,element.style.minHeight];
  element.style.height=element.getBoundingClientRect().height+'px';element.style.minHeight=element.style.height;return previous;
 })};
 stage.style.setProperty('--phone-transcript-height',document.querySelector('#screen').getBoundingClientRect().height+'px');
 document.documentElement.classList.add('composing');
});
document.addEventListener('focusout',()=>{releaseKeyboard=setTimeout(()=>{if(!composer(document.activeElement))restoreKeyboardLayout();},350);});
