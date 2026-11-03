  // Entirely hand-written, local demonstration. No model, fetch, socket or storage.
  const command='join my beeline room at usebeeline.app/mcp';
  const ledger=document.getElementById('room-ledger'),messages=document.getElementById('messages'),input=document.getElementById('message-input');
  const terminal=document.getElementById('join-terminal'),typed=document.getElementById('typed-prompt'),status=document.getElementById('live-status');
  const cast={alan:'Alan',jimmy:'Jimmy',grok:'grok bot',codex:'Codex',claude:'Claude Code',hermes:'Hermes',you:'You'};
  const icons=Object.fromEntries(nodeEls.map(n=>[n.dataset.id,n.querySelector('.tile').innerHTML]));
  for(const element of document.querySelectorAll('[data-icon]'))element.innerHTML=icons[element.dataset.icon]||icons.alan;
  document.getElementById('sidebar-cast').innerHTML=['alan','jimmy','grok','codex','claude','hermes'].map(id=>'<div class="sidebar-person" data-person="'+id+'"><span class="agent-icon">'+icons[id]+'</span>'+cast[id]+'<i></i></div>').join('');
  const entries=[
    {at:0,who:'alan',text:'<span class="m">@grok bot</span>, tell me all user feedback that comes in on X for our product.'},
    {at:2400,who:'grok',text:'On it. Checking X now.'},
    {at:5200,who:'grok',text:'Here are 3 feature requests and 2 bug reports that came in this morning.',attachment:"feedback"},
    {at:8200,who:'jimmy',text:'Hmm, I think doing items 2 and 3 may make the UI too cluttered, what do you think <span class="m">@Alan</span>?'},
    {at:15000,who:'codex',system:true,text:'<span class="m">Codex</span> joined · same session, skills and tools.'},
    {at:17000,who:'alan',text:'You’re right. <span class="m">@Codex</span>, go build item 1, and <span class="m">@Claude Code</span>, go make the bug fixes.'},
    {at:20200,who:'codex',text:'On it. Building item 1 with my existing setup.',attachment:'build'},
    {at:22500,who:'claude',text:'On it. Fixing the two bugs and running the checks.',attachment:'tests'},
    {at:25200,who:'codex',text:'Item 1 is ready. The saved-conversation checks pass.',attachment:'passed'},
    {at:25600,who:'claude',text:'Both bug fixes pass their regression checks.'},
    {at:27000,who:'jimmy',text:'<span class="m">@Hermes</span>, make a video of the new features and announce it on YouTube and X via video. Send me a report when you are done.'},
    {at:30500,who:'hermes',text:'On it. Rendering the feature video.'},
    {at:33500,who:'hermes',text:'Trusty Squire is connecting the announcement accounts.'},
    {at:36100,who:'hermes',text:'The video and posts are ready for the team.'},
    {at:38900,who:'hermes',text:'Here’s the feature announcement report, in the same Room.',attachment:'report'}
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
  function renderHistory(){history=history.slice(-50);publish();}
  function publish(){window.r7Render?.({history:[...history],active:[...active],elapsed,mode});}
  function syncMessages(){let changed=false;entries.forEach((entry,index)=>{if(entry.at<=elapsed&&!seen.has(index)){seen.add(index);history.push({...entry,loop:cycle});changed=true;}});if(changed)renderHistory();}
  function updateWork(){publish();}
  function syncPhoneInvitation(){}
  function update(){
    const scene=scenes.findLastIndex(s=>s.at<=elapsed),connected=elapsed>=15000;
    stage.classList.toggle('codex-connected',connected);document.querySelector('[data-id="codex"]').classList.toggle('not-joined',!connected);
    const inviting=elapsed>=11800&&elapsed<15000;terminal.hidden=true;stage.classList.toggle('inviting-codex',inviting);if(inviting){typed.textContent=command.slice(0,Math.max(0,Math.min(command.length,Math.floor((elapsed-12000)/43))));}
    if(scene!==lastScene&&mode==='script'){lastScene=scene;active=scenes[scene].active;refreshActivity();active.forEach(pulseConnection);}syncMessages();syncPhoneInvitation(inviting);updateWork();
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
  window.r7Typing=()=>{pause();clearReplies();mode='typing';};
  window.r7Send=value=>{value=value.trim();if(!value)return;pause();clearReplies();mode='banter';history.push({who:'you',text:value,visitor:true});renderHistory();responses(value).forEach((reply,i)=>replyTimers.push(setTimeout(()=>{history.push(reply);active=[reply.who];renderHistory();refreshActivity();pulseConnection(reply.who);},650+i*750)));replyTimers.push(setTimeout(()=>{mode='script';lastScene=-1;update();play();},2600));};
  document.addEventListener('visibilitychange',()=>document.hidden?pause():play());
  const sections=[...document.querySelectorAll('.fullpage')];
  const observer=new IntersectionObserver(entries=>{for(const entry of entries){if(entry.intersectionRatio>=.72){sections.forEach(s=>s.classList.toggle('is-landed',s===entry.target));landed=entry.target.id;if(landed==='hero'&&!query.has('still'))play();else pause();}}},{threshold:[.1,.72,.95]});sections.forEach(s=>observer.observe(s));
  window.r7Demo={seek,play,pause,responses,state:()=>({elapsed,playing,mode,cycle,active,landed,joined:elapsed>=15000,terminalVisible:!terminal.hidden,prompt:typed.textContent,messages:history.length,visitorMessages:history.filter(e=>e.visitor).length,localReplies:history.filter(e=>e.localReply).length,history:history.map(e=>({who:e.who,visitor:!!e.visitor,localReply:!!e.localReply,text:e.text}))})};
  refreshActivity();elapsed=Number(query.get('at'))||0;update();if(!query.has('still'))play();
