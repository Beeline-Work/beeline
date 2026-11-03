(function(){
  const stage=document.getElementById('stage'), wrap=stage.parentElement;
  const wires=document.getElementById('wires'), screen=document.getElementById('screen');

  const nodeEls=[...document.querySelectorAll('.node')];
  const WIDE={w:880,h:600,pw:320,ph:600}, TALL={w:380,h:880,pw:300,ph:540};
  let F=WIDE, geo=[];

  function layout(){
    F = wrap.clientWidth >= 780 ? WIDE : TALL;
    stage.style.setProperty('--fw',F.w+'px'); stage.style.setProperty('--fh',F.h+'px');
    stage.style.setProperty('--pw',F.pw+'px'); stage.style.setProperty('--ph',F.ph+'px');
    nodeEls.forEach(n=>{
      const x = F===WIDE ? +n.dataset.x : +n.dataset.mx;
      const y = F===WIDE ? +n.dataset.y : +n.dataset.my;
      n.style.left=(x/F.w*100)+'%'; n.style.top=(y/F.h*100)+'%';
    });
    const s=Math.min(1, wrap.clientWidth/F.w);
    stage.style.setProperty('--s',s);
    wrap.style.height=(F.h*s)+'px';
  }

  // circuit routing: leave the tile square-on, run down a channel, enter a pad
  function elbow(sx, sy, cx, ey, ex, r){
    const dx1 = Math.sign(cx - sx), dy = Math.sign(ey - sy), dx2 = Math.sign(ex - cx);
    const rr = Math.min(r, Math.abs(cx-sx), Math.abs(ex-cx), Math.abs(ey-sy)/2) || 0;
    if(!dy) return `M ${sx} ${sy} H ${ex}`;
    return `M ${sx} ${sy} H ${cx - dx1*rr} Q ${cx} ${sy} ${cx} ${sy + dy*rr}`
         + ` V ${ey - dy*rr} Q ${cx} ${ey} ${cx + dx2*rr} ${ey} H ${ex}`;
  }
  function velbow(sx, sy, cy, ex, ey, r){
    const dy1 = Math.sign(cy - sy), dx = Math.sign(ex - sx), dy2 = Math.sign(ey - cy);
    const rr = Math.min(r, Math.abs(cy-sy), Math.abs(ey-cy), Math.abs(ex-sx)/2) || 0;
    if(!dx) return `M ${sx} ${sy} V ${ey}`;
    return `M ${sx} ${sy} V ${cy - dy1*rr} Q ${sx} ${cy} ${sx + dx*rr} ${cy}`
         + ` H ${ex - dx*rr} Q ${ex} ${cy} ${ex} ${cy + dy2*rr} V ${ey}`;
  }
  function pad(x,y){
    const g=document.createElementNS('http://www.w3.org/2000/svg','rect');
    g.setAttribute('x',x-2.5); g.setAttribute('y',y-2.5);
    g.setAttribute('width',5); g.setAttribute('height',5);
    g.setAttribute('class','pad'); wires.appendChild(g);
  }
  function draw(){
    wires.setAttribute('viewBox','0 0 '+F.w+' '+F.h); wires.innerHTML=''; geo=[];
    const pw=F.pw, ph=F.ph, px=(F.w-pw)/2, py=(F.h-ph)/2;
    const half=26, R=10;
    const lefts=[], rights=[];
    nodeEls.forEach(n=>((F===WIDE ? +n.dataset.x : +n.dataset.mx) < F.w/2 ? lefts : rights).push(n));
    nodeEls.forEach(n=>{
      const x = F===WIDE ? +n.dataset.x : +n.dataset.mx;
      const y = F===WIDE ? +n.dataset.y : +n.dataset.my;
      let d, ex, ey;
      if(F===WIDE){
        const left = x < F.w/2;
        const band = left ? lefts : rights;
        const i = band.indexOf(n), k = band.length;
        // a connector: pads on a fixed pitch, centred on the screen's edge
        const pitch = 88;
        ey = py + ph/2 + (i - (k-1)/2) * pitch;
        ex = left ? px : px + pw;
        const sx = left ? x + half : x - half;
        const chan = left ? px - 46 - (k-1-i)*16 : px + pw + 46 + i*16;
        d = elbow(sx, y, chan, ey, ex, R);
      } else {
        const above = y < py;
        const band = above ? lefts.concat(rights).filter(m=>+m.dataset.my < py) : nodeEls.filter(m=>+m.dataset.my > py);
        const i = band.indexOf(n), k = band.length;
        const pitch = Math.min(64, (pw - 80) / Math.max(1, k-1));
        ex = px + pw/2 + (i - (k-1)/2) * pitch;
        ey = above ? py : py + ph;
        const sy = above ? y + half + 18 : y - n.offsetHeight/2;
        // Keep lower channels between the screen and the profile's upper pad:
        // a channel below sy makes the wire leave the profile downward first.
        const chan = above ? py - 34 - (k-1-i)*12 : ey + (sy-ey)*(i+1)/(k+1);
        d = velbow(x, sy, chan, ex, ey, R);
      }
      const p=document.createElementNS('http://www.w3.org/2000/svg','path');
      p.setAttribute('d', d); wires.appendChild(p);
      pad(ex, ey);
      p.dataset.actor=n.dataset.id;
      geo.push({node:n, path:p, id:n.dataset.id, d:d});
    });
  }
  layout(); draw();
  addEventListener('resize',()=>{layout();draw();refreshActivity();});


  // Offline fixture only. No request, socket, model call or persistent storage.
  const command='join my beeline room at usebeeline.app/mcp';
  const ledger=document.getElementById('room-ledger'), messages=document.getElementById('messages');
  const terminal=document.getElementById('join-terminal'), typed=document.getElementById('typed-prompt');
  const members=document.getElementById('member-count'), status=document.getElementById('live-status');
  const playback=document.getElementById('playback'), input=document.getElementById('message-input');
  const cast={alan:'Alan',jimmy:'Jimmy',grok:'grok bot',codex:'Codex',claude:'Claude Code',hermes:'Hermes',you:'You'};
  const icons=Object.fromEntries(nodeEls.map(n=>[n.dataset.id,n.querySelector('.tile').innerHTML]));
  const feedback='<div class="card"><div class="ttl">This morning on X</div><div class="desc"><strong>3 feature requests</strong><ol><li>Save a useful conversation.</li><li>Show more activity badges.</li><li>Add another sidebar panel.</li></ol><strong>2 bug reports</strong><div>Search loses focus · unread count sticks</div></div></div>';
  const entries=[
    {at:0,who:'alan',text:'<span class="m">@grok bot</span>, tell me all user feedback that comes in on X for our product.'},
    {at:6100,who:'grok',text:'On it. Here are 3 feature requests and 2 bug reports that came in this morning.',card:feedback},
    {at:10300,who:'jimmy',text:'Hmm, I think doing items 2 and 3 may make the UI too cluttered, what do you think <span class="m">@Alan</span>?'},
    {at:18200,who:'codex',system:true,text:'<span class="m">Codex</span> joined · same session, skills and tools.'},
    {at:20500,who:'alan',text:'You’re right. <span class="m">@Codex</span>, go build item 1, and <span class="m">@Claude Code</span>, go make the bug fixes.'},
    {at:24500,who:'codex',text:'On it.',card:'<div class="card"><div class="state">BUILDING · ITEM 1</div><div class="ttl">Save a useful conversation</div><div class="desc">Using my existing project, skills and tools.</div></div>'},
    {at:26700,who:'claude',text:'On it.',card:'<div class="card"><div class="state">FIXING · 2 BUG REPORTS</div><div class="ttl">Search focus and unread count</div></div>'},
    {at:28900,who:'jimmy',text:'<span class="m">@Hermes</span>, make a video of the new features and announce it on YouTube and X via video. Send me a report when you are done.'},
    {at:33300,who:'hermes',text:'On it. I’m making the feature video and the announcement.'},
    {at:36300,who:'hermes',text:'Here’s the video and announcement report for everyone.',card:'<div class="card"><div class="state">SAMPLE REPORT</div><div class="ttl">New feature: saved conversations</div><div class="desc">Feature video · YouTube + X announcement<br>Scripted preview — nothing published.</div></div>'},
  ];
  const scenes=[
    {at:0,active:['alan'],label:'Alan · asking the whole team'},
    {at:4200,active:['grok'],label:'grok bot · checking feedback on X'},
    {at:6100,active:['grok'],label:'grok bot · sharing feedback'},
    {at:10300,active:['jimmy'],label:'Jimmy · weighing in'},
    {at:14600,active:[],label:'Codex · bringing the existing session'},
    {at:18200,active:['codex'],label:'Codex · connected to the Room'},
    {at:20500,active:['alan'],label:'Alan · handing off the work'},
    {at:24500,active:['codex'],label:'Codex · building item 1'},
    {at:26700,active:['codex','claude'],label:'Codex + Claude Code · working'},
    {at:28900,active:['jimmy'],label:'Jimmy · briefing Hermes'},
    {at:33300,active:['hermes'],label:'Hermes · making the feature video'},
    {at:36300,active:['hermes'],label:'Hermes · sharing the report'},
    {at:40800,active:[],label:'Same context. The whole team.'},
  ];
  const end=40800, reduced=matchMedia('(prefers-reduced-motion: reduce)').matches;
  let elapsed=0,base=performance.now(),playing=false,raf=0,lastScene=-1,rendered=0,visitorMessages=[],active=[];
  function refreshActivity(){
    stage.classList.toggle('phone',F===TALL);
    for(const g of geo){const on=active.includes(g.id);g.node.classList.toggle('live',on);g.path.classList.toggle('hot',on);}
  }
  function pulseConnection(id){
    if(reduced)return;
    const g=geo.find(g=>g.id===id);if(!g)return;
    const dot=document.createElementNS('http://www.w3.org/2000/svg','circle');dot.setAttribute('r','3');dot.setAttribute('class','spark');dot.style.offsetPath=`path("${g.d}")`;dot.style.offsetRotate='0deg';wires.appendChild(dot);requestAnimationFrame(()=>dot.classList.add('run'));dot.addEventListener('animationend',()=>dot.remove(),{once:true});
  }
  function makeTurn(entry,index){
    const turn=document.createElement('div');turn.className='turn in'+(entry.system?' sys':'')+(entry.visitor?' visitor':'');
    if(entry.system){turn.innerHTML='<div class="say">'+entry.text+'</div>';return turn;}
    const human=['alan','jimmy','you'].includes(entry.who);
    turn.innerHTML='<div class="byline '+(human?'hu':'ag')+'"><span class="av">'+(icons[entry.who]||icons.alan)+'</span><span class="who"'+(human?' style="color:var(--brass)"':'')+'>'+cast[entry.who]+'</span><span class="kind">'+(entry.visitor?'LOCAL':'')+'</span><span class="at">'+(entry.visitor?'now':'09:'+String(41+index).padStart(2,'0'))+'</span></div>';
    const say=document.createElement('div');say.className='say';if(entry.visitor)say.textContent=entry.text;else say.innerHTML=entry.text;turn.appendChild(say);
    if(entry.card)turn.insertAdjacentHTML('beforeend',entry.card);
    return turn;
  }
  function scrollLatest(){ledger.scrollTop=ledger.scrollHeight;}
  function syncMessages(force=false){
    const visible=entries.filter(e=>e.at<=elapsed);
    if(force||visible.length!==rendered){messages.replaceChildren(...visible.map(makeTurn),...visitorMessages.map((e,i)=>makeTurn(e,entries.length+i)));rendered=visible.length;scrollLatest();}
  }
  function update(){
    const scene=scenes.findLastIndex(s=>s.at<=elapsed);
    const connected=elapsed>=18200;
    stage.classList.toggle('codex-connected',connected);
    document.querySelector('[data-id="codex"]').classList.toggle('not-joined',!connected);
    members.textContent=(connected?'6':'5')+' members ›';
    const inviting=elapsed>=14600&&elapsed<19500;
    terminal.hidden=!inviting;
    if(inviting){const n=reduced?command.length:Math.min(command.length,Math.floor((elapsed-14800)/43));typed.textContent=command.slice(0,Math.max(0,n));document.getElementById('terminal-state').textContent=connected?'Connected · same session, skills, tools':'same session · skills · tools';}
    if(scene!==lastScene){lastScene=scene;active=scenes[scene].active;refreshActivity();active.forEach(pulseConnection);}
    syncMessages();
    status.textContent=scenes[scene].label;
    playback.textContent=elapsed>=end?'replay ↻':playing?'pause Ⅱ':'play ▷';
    playback.setAttribute('aria-label',elapsed>=end?'Replay demo':playing?'Pause demo':'Play demo');
  }
  function tick(now){elapsed=Math.min(end,now-base);if(elapsed>=end)playing=false;update();if(playing)raf=requestAnimationFrame(tick);}
  function pause(){if(playing)elapsed=Math.min(end,performance.now()-base);playing=false;cancelAnimationFrame(raf);update();}
  function play(){if(elapsed>=end){elapsed=0;lastScene=-1;rendered=-1;}base=performance.now()-elapsed;playing=true;cancelAnimationFrame(raf);raf=requestAnimationFrame(tick);update();}
  function seek(ms){pause();elapsed=Math.max(0,Math.min(end,ms));update();}
  playback.onclick=()=>playing?pause():play();
  input.addEventListener('focus',pause);
  document.getElementById('composer').addEventListener('submit',event=>{
    event.preventDefault();const value=input.value.trim();if(!value)return;pause();visitorMessages.push({who:'you',text:value,visitor:true});input.value='';syncMessages(true);status.textContent='Your message · local demo';
  });
  document.addEventListener('visibilitychange',()=>{if(document.hidden)pause();});
  window.r5Demo={seek,play,pause,state:()=>({elapsed,playing,scene:lastScene,active,joined:elapsed>=18200,terminalVisible:!terminal.hidden,prompt:typed.textContent,messages:rendered,visitorMessages:visitorMessages.length})};
  refreshActivity();
  const query=new URLSearchParams(location.search);elapsed=Number(query.get('at'))||0;update();
  if(!query.has('still')&&!reduced)play();

})();
