  // Entirely hand-written, local demonstration. No model, fetch, socket or storage.
  const command='join my beeline room at usebeeline.app/mcp';
  const ledger=document.getElementById('room-ledger'),messages=document.getElementById('messages'),input=document.getElementById('message-input');
  const terminal=document.getElementById('join-terminal'),typed=document.getElementById('typed-prompt'),status=document.getElementById('live-status');
  const cast={alan:'Alan',jimmy:'Jimmy',grok:'grok bot',codex:'Codex',claude:'Claude Code',hermes:'Hermes',you:'You'};
  const icons=Object.fromEntries(nodeEls.map(n=>[n.dataset.id,n.querySelector('.tile').innerHTML]));
  for(const element of document.querySelectorAll('[data-icon]'))element.innerHTML=icons[element.dataset.icon]||icons.alan;
  document.getElementById('sidebar-cast').innerHTML=['alan','jimmy','grok','codex','claude','hermes'].map(id=>'<div class="sidebar-person" data-person="'+id+'"><span class="agent-icon">'+icons[id]+'</span>'+cast[id]+'<i></i></div>').join('');
  const progress='<div class="work-progress"><i></i></div>';
  const graphics={
    grok:'<div class="work-card grok-work" data-work="grok"><div class="work-head"><span class="work-logo">𝕏</span><span>SCANNING PRODUCT FEEDBACK</span></div><div class="scan-feed"><div class="feed-row"><i class="feed-dot"></i><div>Can we save a useful conversation?<small>FEATURE REQUEST</small></div></div><div class="feed-row"><i class="feed-dot"></i><div>Search keeps dropping my cursor.<small>BUG REPORT</small></div></div><div class="feed-row"><i class="feed-dot"></i><div>That unread count is stuck again.<small>BUG REPORT</small></div></div><i class="scan-line"></i></div>'+progress+'</div>',
    codex:'<div class="work-card" data-work="codex"><div class="work-head"><b>Saved conversations</b><span>BUILDING</span></div><div class="work-files"><div class="file-row"><span>saved-conversations.ts</span><b>+42 −3</b></div><div class="file-row"><span>save-menu.tsx</span><b>+18</b></div><div class="file-row"><span>saved.test.ts</span><b>+26</b></div></div><div class="code-diff"><div class="diff-minus">− return conversation;</div><div class="diff-plus">+ await saveConversation(id);</div><div class="diff-plus">+ return { ...conversation, saved: true };</div></div>'+progress+'</div>',
    claude:'<div class="work-card" data-work="claude"><div class="work-head"><b>Regression checks</b><span>RUNNING TESTS</span></div><div class="test-row"><i>○</i><span>search retains focus</span></div><div class="test-row"><i>○</i><span>unread count clears</span></div><div class="test-row"><i>○</i><span>Room updates stay in sync</span></div><div class="test-summary">Running the checks…</div>'+progress+'</div>',
    hermes:'<div class="work-card" data-work="hermes"><div class="work-head"><b>Feature announcement</b><span>RENDERING VIDEO</span></div><div class="video-thumb"><span>▶</span><strong>Save the conversation.<br>Keep the context.</strong><small>00:24 · FEATURE VIDEO</small></div>'+progress+'</div>',
    connect:'<div class="work-card" data-work="connect"><div class="work-head"><b>Trusty Squire</b><span>CONNECTING SERVICES</span></div><div class="service-connection"><div class="service-box">S</div><div class="service-link"></div><div class="service-box youtube">▶</div><div class="service-box">𝕏</div></div><div class="connect-status">Trusty Squire → YouTube + X</div>'+progress+'<div class="work-sample">Scripted connection · no account is connected</div></div>',
    posts:'<div class="work-card" data-work="posts"><div class="work-head"><b>Announcement previews</b><span>READY TO SHARE</span></div><div class="post-cards"><div class="post-card"><b>▶ YouTube</b>Saved conversations · feature video<small>VIDEO READY ✓</small></div><div class="post-card"><b>𝕏</b>Keep the conversation that matters.<small>POST READY ✓</small></div></div><div class="work-sample">Sample previews · nothing published</div></div>'
  };
  const feedback='<div class="card"><div class="ttl">This morning on X</div><div class="desc"><strong>3 feature requests</strong><ol><li>Save a useful conversation.</li><li>Show more activity badges.</li><li>Add another sidebar panel.</li></ol><strong>2 bug reports</strong><div>Search loses focus · unread count sticks</div></div></div>';
  const entries=[
    {at:0,who:'alan',text:'<span class="m">@grok bot</span>, tell me all user feedback that comes in on X for our product.'},
    {at:2400,who:'grok',text:'On it. Checking X now.',card:graphics.grok},
    {at:5200,who:'grok',text:'Here are 3 feature requests and 2 bug reports that came in this morning.',card:feedback},
    {at:8200,who:'jimmy',text:'Hmm, I think doing items 2 and 3 may make the UI too cluttered, what do you think <span class="m">@Alan</span>?'},
    {at:15000,who:'codex',system:true,text:'<span class="m">Codex</span> joined · same session, skills and tools.'},
    {at:17000,who:'alan',text:'You’re right. <span class="m">@Codex</span>, go build item 1, and <span class="m">@Claude Code</span>, go make the bug fixes.'},
    {at:20200,who:'codex',text:'On it. Building item 1 with my existing setup.',card:graphics.codex},
    {at:22500,who:'claude',text:'On it. Fixing the two bugs and running the checks.',card:graphics.claude},
    {at:25200,who:'codex',text:'Item 1 is ready. The saved-conversation checks pass.'},
    {at:25600,who:'claude',text:'Both bug fixes pass their regression checks.'},
    {at:27000,who:'jimmy',text:'<span class="m">@Hermes</span>, make a video of the new features and announce it on YouTube and X via video. Send me a report when you are done.'},
    {at:30500,who:'hermes',text:'On it. Rendering the feature video.',card:graphics.hermes},
    {at:33500,who:'hermes',text:'Trusty Squire is connecting the announcement accounts.',card:graphics.connect},
    {at:36100,who:'hermes',text:'The video and posts are ready for the team.',card:graphics.posts},
    {at:38900,who:'hermes',text:'Here’s the feature announcement report, in the same Room.',card:'<div class="card"><div class="state">SAMPLE REPORT</div><div class="ttl">Saved conversations · feature announcement</div><div class="desc">Video rendered. YouTube + X previews ready.<br>Scripted demo — nothing published.</div></div>'}
  ];
  const scenes=[
    {at:0,active:['alan'],label:'Alan · asking the whole team'},
    {at:2400,active:['grok'],label:'grok bot · scanning feedback on X'},
    {at:5200,active:['grok'],label:'grok bot · sharing the feedback'},
    {at:8200,active:['jimmy'],label:'Jimmy · weighing in'},
    {at:11800,active:[],label:'Codex · bringing its existing session'},
    {at:15000,active:['codex'],label:'Codex · connected to the Room'},
    {at:17000,active:['alan'],label:'Alan · handing off the work'},
    {at:20200,active:['codex'],label:'Codex · building the feature'},
    {at:22500,active:['codex','claude'],label:'Codex + Claude Code · building and checking'},
    {at:25600,active:['claude'],label:'Claude Code · checks are green'},
    {at:27000,active:['jimmy'],label:'Jimmy · briefing Hermes'},
    {at:30500,active:['hermes'],label:'Hermes · rendering the video'},
    {at:33500,active:['hermes'],label:'Hermes · connecting via Trusty Squire'},
    {at:36100,active:['hermes'],label:'Hermes · preparing YouTube + X posts'},
    {at:38900,active:['hermes'],label:'Hermes · sharing the report'},
  ];
  const query=new URLSearchParams(location.search);
  const end=43000,reduced=matchMedia('(prefers-reduced-motion: reduce)').matches;
  let elapsed=0,base=performance.now(),playing=false,raf=0,lastScene=-1,history=[],seen=new Set(),active=[],cycle=0,mode='script',replyTimers=[],landed='hero';
  function refreshActivity(){stage.classList.toggle('phone',F===TALL);for(const g of geo){const on=active.includes(g.id);g.node.classList.toggle('live',on);g.path.classList.toggle('hot',on);}for(const person of document.querySelectorAll('.sidebar-person'))person.classList.toggle('active',active.includes(person.dataset.person));}
  function pulseConnection(id){if(reduced)return;const g=geo.find(g=>g.id===id);if(!g)return;const dot=document.createElementNS('http://www.w3.org/2000/svg','circle');dot.setAttribute('r','3');dot.setAttribute('class','spark');dot.style.offsetPath=`path("${g.d}")`;dot.style.offsetRotate='0deg';wires.appendChild(dot);requestAnimationFrame(()=>dot.classList.add('run'));dot.addEventListener('animationend',()=>dot.remove(),{once:true});}
  function makeTurn(entry,index){
    const turn=document.createElement('div');turn.className='turn in'+(entry.system?' sys':'')+(entry.visitor?' visitor':'')+(entry.localReply?' local-reply':'');turn.dataset.actor=entry.who;turn.dataset.loop=entry.loop??cycle;
    if(entry.system){turn.innerHTML='<div class="say">'+entry.text+'</div>';return turn;}
    const human=['alan','jimmy','you'].includes(entry.who);turn.innerHTML='<div class="byline '+(human?'hu':'ag')+'"><span class="av">'+(icons[entry.who]||icons.alan)+'</span><span class="who"'+(human?' style="color:var(--brass)"':'')+'>'+cast[entry.who]+'</span><span class="kind">'+(entry.visitor||entry.localReply?'LOCAL':'')+'</span><span class="at">'+(entry.visitor||entry.localReply?'now':'09:'+String(41+(index%18)).padStart(2,'0'))+'</span></div>';
    const say=document.createElement('div');say.className='say';if(entry.visitor||entry.localReply)say.textContent=entry.text;else say.innerHTML=entry.text;turn.appendChild(say);if(entry.card)turn.insertAdjacentHTML('beforeend',entry.card);return turn;
  }
  function renderHistory(){history=history.slice(-50);messages.replaceChildren(...history.map(makeTurn));messages.lastElementChild?.classList.add('latest');ledger.scrollTop=ledger.scrollHeight;updateWork();}
  function syncMessages(){let changed=false;entries.forEach((entry,index)=>{if(entry.at<=elapsed&&!seen.has(index)){seen.add(index);history.push({...entry,loop:cycle});changed=true;}});if(changed)renderHistory();}
  function updateWork(){
    const spans={grok:[2400,5200],codex:[20200,25200],claude:[22500,25600],hermes:[30500,33500],connect:[33500,36100],posts:[36100,38900]};
    for(const card of messages.querySelectorAll('[data-work]')){const [start,finish]=spans[card.dataset.work];const fraction=Number(card.closest('.turn').dataset.loop)!==cycle?1:Math.max(0,Math.min(1,(elapsed-start)/(finish-start)));card.style.setProperty('--progress',(fraction*100)+'%');
      if(card.dataset.work==='grok')card.querySelectorAll('.feed-row').forEach((row,i)=>row.style.opacity=fraction>(i/3)?'1':'.2');
      if(card.dataset.work==='claude'){card.querySelectorAll('.test-row').forEach((row,i)=>{const passed=fraction>((i+1)/3-.08);row.classList.toggle('passed',passed);row.querySelector('i').textContent=passed?'✓':'○';});card.querySelector('.test-summary').textContent=fraction>.94?'3 passed · all green':'Running the checks…';}
      if(card.dataset.work==='connect')card.querySelector('.connect-status').textContent=fraction>.82?'Connected ✓ · YouTube + X':'Trusty Squire → YouTube + X';
    }
  }
  function update(){
    const scene=scenes.findLastIndex(s=>s.at<=elapsed),connected=elapsed>=15000;
    stage.classList.toggle('codex-connected',connected);document.querySelector('[data-id="codex"]').classList.toggle('not-joined',!connected);document.getElementById('member-count').textContent=(connected?'6':'5')+' members ›';
    const inviting=elapsed>=11800&&elapsed<15000;terminal.hidden=!inviting;stage.classList.toggle('inviting-codex',inviting);if(inviting){typed.textContent=command.slice(0,Math.max(0,Math.min(command.length,Math.floor((elapsed-12000)/43))));}
    if(scene!==lastScene&&mode==='script'){lastScene=scene;active=scenes[scene].active;refreshActivity();active.forEach(pulseConnection);}syncMessages();updateWork();if(mode==='script')status.textContent=scenes[scene].label;
  }
  function tick(now){elapsed=Math.max(0,now-base);if(elapsed>=end){cycle++;elapsed%=end;base=now-elapsed;seen=new Set();lastScene=-1;}update();if(playing)raf=requestAnimationFrame(tick);}
  function pause(){if(playing)elapsed=Math.max(0,(performance.now()-base)%end);playing=false;cancelAnimationFrame(raf);}
  function play(){if(landed!=='hero'||mode!=='script'||document.hidden)return;base=performance.now()-elapsed;playing=true;cancelAnimationFrame(raf);raf=requestAnimationFrame(tick);}
  function seek(ms){pause();if(ms<elapsed){history=[];seen=new Set();}elapsed=Math.max(0,Math.min(end-1,ms));mode='script';update();}
  // A fixed response table, keyed on agent names or simple keywords. Never generated.
  const replyTable={
    grok:{hello:'Hey! The whole team’s here. No forwarding screenshots required.',feedback:'I’ve got the feedback. The internet has opinions. Several, in fact.',generic:'I’m listening. So is everyone else — that’s the nice part.'},
    codex:{tools:'Same session, same tools. I packed my skills too.',build:'On it. My to-do list just got a little more interesting.',generic:'I’m here, with my usual setup. What are we making?'},
    claude:{bug:'Tests first, victory lap second. I’ll take a look.',generic:'I’ll check the edge cases. Someone has to keep Codex honest.'},
    hermes:{video:'A video? Finally, a job with a play button.',generic:'I’ll bring the thumbnail. You bring the good news.'}
  };
  function responses(text){const t=text.toLowerCase(),named=[['codex',/codex/],['claude',/claude/],['hermes',/hermes/],['grok',/grok/]].filter(([,r])=>r.test(t)).map(([id])=>id);let ids=named.length?named.slice(0,2):/bug|test|broken/.test(t)?['claude','codex']:/video|youtube|announce/.test(t)?['hermes','grok']:/skill|tool|mcp|subscription/.test(t)?['codex','claude']:/feedback|research|\bx\b/.test(t)?['grok','claude']:['grok','hermes'];if(ids.length===1)ids.push(ids[0]==='claude'?'codex':'claude');return ids.map(who=>({who,localReply:true,text:who==='grok'?replyTable.grok[/hello|\bhi\b|hey/.test(t)?'hello':/feedback|research|\bx\b/.test(t)?'feedback':'generic']:who==='codex'?replyTable.codex[/skill|tool|mcp|subscription/.test(t)?'tools':/build|make|feature/.test(t)?'build':'generic']:who==='claude'?replyTable.claude[/bug|test|broken/.test(t)?'bug':'generic']:replyTable.hermes[/video|youtube|announce/.test(t)?'video':'generic']}));}
  function clearReplies(){replyTimers.forEach(clearTimeout);replyTimers=[];}
  input.addEventListener('input',()=>{pause();clearReplies();mode='typing';status.textContent='Your turn · local demo';});
  input.addEventListener('focus',()=>{pause();mode='typing';});
  input.addEventListener('blur',()=>{if(!input.value.trim()&&mode==='typing'){mode='script';play();}});
  document.getElementById('composer').addEventListener('submit',event=>{event.preventDefault();const value=input.value.trim();if(!value)return;pause();clearReplies();mode='banter';history.push({who:'you',text:value,visitor:true});input.value='';renderHistory();status.textContent='The team is replying…';responses(value).forEach((reply,i)=>replyTimers.push(setTimeout(()=>{history.push(reply);renderHistory();active=[reply.who];refreshActivity();pulseConnection(reply.who);status.textContent=cast[reply.who]+' · replying to you';},650+i*750)));replyTimers.push(setTimeout(()=>{mode='script';lastScene=-1;update();play();},2600));});
  document.addEventListener('visibilitychange',()=>document.hidden?pause():play());
  const sections=[...document.querySelectorAll('.fullpage')];
  const observer=new IntersectionObserver(entries=>{for(const entry of entries){if(entry.intersectionRatio>=.72){sections.forEach(s=>s.classList.toggle('is-landed',s===entry.target));landed=entry.target.id;if(landed==='hero'&&!query.has('still'))play();else pause();}}},{threshold:[.1,.72,.95]});sections.forEach(s=>observer.observe(s));
  window.r6Demo={seek,play,pause,responses,state:()=>({elapsed,playing,mode,cycle,active,landed,joined:elapsed>=15000,terminalVisible:!terminal.hidden,prompt:typed.textContent,messages:history.length,visitorMessages:history.filter(e=>e.visitor).length,localReplies:history.filter(e=>e.localReply).length,history:history.map(e=>({who:e.who,visitor:!!e.visitor,localReply:!!e.localReply,text:e.text}))})};
  refreshActivity();elapsed=Number(query.get('at'))||0;update();if(!query.has('still'))play();
