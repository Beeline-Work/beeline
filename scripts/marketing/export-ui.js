async () => {
 await document.fonts.ready;
 const room=document.querySelector('[data-native-room=hero]');
 const entries=[...room.querySelectorAll('[data-entry-actor]')].map(e=>({who:e.dataset.entryActor,html:e.outerHTML}));
 const clean=e=>{const c=e.cloneNode(true);c.querySelectorAll('[data-testid]').forEach(n=>{if(/^hero-text/.test(n.dataset.testid))n.dataset.messageBody='';});return c.outerHTML;};
 const generic={};
 for(const e of room.querySelectorAll('[data-entry-actor]'))if(!generic[e.dataset.entryActor]&&e.querySelector('[data-testid=chat-byline-mark]')){
  const c=e.cloneNode(true);while(c.children.length>1)c.lastElementChild.remove();const body=c.querySelector('[data-testid^=hero-text]');body.dataset.messageBody='';
  const byline=c.querySelector('[data-testid=chat-byline-mark]');while(byline.children.length>1)byline.lastElementChild.remove();
  generic[e.dataset.entryActor]=c.outerHTML;
 }
 const blank=room.cloneNode(true),ledger=blank.querySelector('.native-ledger');ledger.replaceChildren();
 blank.querySelector('[data-testid=hero-turn-slot]').remove();blank.querySelector('textarea').removeAttribute('id');
 blank.querySelector('textarea').setAttribute('maxlength','1000');blank.querySelector('[aria-label="Send message"]').removeAttribute('disabled');blank.querySelector('[aria-label="Send message"]').setAttribute('aria-disabled','false');
 const status=room.querySelector('[data-testid=hero-turn-slot]').cloneNode(true);status.querySelector('[role=progressbar]').setAttribute('role','status');
 const statusLabel=status.querySelector('[data-testid=hero-working]').querySelector('[dir=auto]');statusLabel.dataset.statusLabel='';
 const cat=document.querySelector('.node[data-id=codex] [data-testid=codex-shared-mark]').cloneNode(true);while(cat.children.length>1)cat.lastElementChild.remove();
 const native=document.querySelector('#react-native-stylesheet');
 const css=[...native.sheet.cssRules].map(r=>r.cssText).join('\n');
 return {entries,generic,room:blank.outerHTML,status:status.outerHTML,cat:cat.outerHTML,css,date:room.querySelector('.native-ledger>div').outerHTML,spacer:room.querySelector('.native-ledger>div:last-child').outerHTML,sync:document.querySelector('#native-sync').innerHTML,context:document.querySelector('#native-context').innerHTML,sidebar:document.querySelector('#sidebar-cast').innerHTML,codexNode:document.querySelector('.node[data-id=codex]').outerHTML,body:document.body.innerHTML};
}
