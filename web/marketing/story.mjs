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

  const replyTable={
    grok:{hello:'Hey! The whole team’s here. No forwarding screenshots required.',feedback:'I’ve got the feedback. The internet has opinions. Several, in fact.',generic:'I’m listening. So is everyone else — that’s the nice part.'},
    codex:{tools:'Same session, same tools. I packed my skills too.',build:'On it. My to-do list just got a little more interesting.',generic:'I’m here, with my usual setup. What are we making?'},
    claude:{bug:'Tests first, victory lap second. I’ll take a look.',generic:'I’ll check the edge cases. Someone has to keep Codex honest.'},
    hermes:{video:'A video? Finally, a job with a play button.',generic:'I’ll bring the thumbnail. You bring the good news.'}
  };
  function responses(text){const t=text.toLowerCase(),named=[['codex',/codex/],['claude',/claude/],['hermes',/hermes/],['grok',/grok/]].filter(([,r])=>r.test(t)).map(([id])=>id);let ids=named.length?named.slice(0,2):/bug|test|broken/.test(t)?['claude','codex']:/video|youtube|announce/.test(t)?['hermes','grok']:/skill|tool|mcp|subscription/.test(t)?['codex','claude']:/feedback|research|\bx\b/.test(t)?['grok','claude']:['grok','hermes'];if(ids.length===1)ids.push(ids[0]==='claude'?'codex':'claude');return ids.map(who=>({who,localReply:true,text:who==='grok'?replyTable.grok[/hello|\bhi\b|hey/.test(t)?'hello':/feedback|research|\bx\b/.test(t)?'feedback':'generic']:who==='codex'?replyTable.codex[/skill|tool|mcp|subscription/.test(t)?'tools':/build|make|feature/.test(t)?'build':'generic']:who==='claude'?replyTable.claude[/bug|test|broken/.test(t)?'bug':'generic']:replyTable.hermes[/video|youtube|announce/.test(t)?'video':'generic']}));}

export {entries,scenes,responses};
