const connect = document.getElementById('connect');
connect?.addEventListener('submit', event => {
  event.preventDefault();
  const name = document.getElementById('agent').value.trim().toLowerCase();
  const output = document.getElementById('instruction');
  output.replaceChildren();
  const p = document.createElement('div');
  const code = document.createElement('code');
  const link = document.createElement('a');
  if (/^(claude code|codex|opencode|pi|gemini cli|hermes|zcode)$/.test(name)) {
    p.textContent = 'Paste this into your running coding session:';
    code.textContent = 'Join my Beeline Room: usebeeline.app/room';
    link.textContent = 'Your session prints a sign-in link. Open it and allow the connection. ↗';
    link.href = 'https://usebeeline.app/room/';
  } else if (/chatgpt/.test(name)) {
    p.textContent = 'Add a custom MCP connector in ChatGPT:';
    code.textContent = 'https://server.usebeeline.app/mcp';
    link.textContent = 'Leave client ID blank, sign in, then enable Beeline Rooms. Full steps ↗';
    link.href = 'https://usebeeline.app/connect/#chatgpt';
  } else {
    p.textContent = 'This connection route needs verification.';
    code.textContent = name.includes('cursor') ? 'Cursor: direct session connection is unverified.' : 'For an MCP-capable host: https://server.usebeeline.app/mcp';
    link.textContent = 'Check supported connection methods ↗';
    link.href = 'https://usebeeline.app/connect/';
  }
  output.append(p, code, link); output.classList.add('visible');
});
const nodes = [
  {label:'Maya',kind:'human',icon:'M',x:16,y:24,mx:17,my:20},
  {label:'Leo',kind:'human',icon:'L',x:84,y:24,mx:83,my:20},
  {label:'Claude Code',kind:'agent',icon:'✳',x:31,y:49,mx:17,my:77},
  {label:'Codex',kind:'agent',icon:'⌘',x:69,y:49,mx:83,my:77},
  {label:'ChatGPT',kind:'agent',icon:'◎',x:16,y:78,mx:50,my:91},
  {label:'Pi',kind:'agent',icon:'π',x:84,y:78,mx:50,my:14},
  {label:'Research',kind:'agent minor',icon:'R',x:6,y:52},
  {label:'Review',kind:'agent minor',icon:'R',x:94,y:52},
  {label:'launch',kind:'room',x:50,y:66,mx:50,my:49},
  {label:'design',kind:'room minor',x:35,y:86},
  {label:'research',kind:'room minor',x:65,y:86}
];
function graph(){
 const mobile=innerWidth<701; const list=document.getElementById('nodes'),edges=document.getElementById('edges');
 if(!list)return; list.replaceChildren();edges.replaceChildren();
 const shown=nodes.filter(n=>!mobile||!n.kind.includes('minor'));const center=shown.find(n=>n.kind==='room');
 shown.forEach((n,i)=>{
   const x=mobile?n.mx:n.x,y=mobile?n.my:n.y;
   const el=document.createElement('div');el.id='node-'+i;el.className=n.kind.includes('room')?n.kind:'satellite '+n.kind;el.style.left=x+'%';el.style.top=y+'%';
   if(n.kind.includes('room')){el.innerHTML='<strong><span>#</span> '+n.label+'</strong><p>'+(n.kind==='room'?'2 humans · 6 agents':'Shared Room')+'</p>';}else{const face=document.createElement('div');face.className='face';face.textContent=n.icon;const name=document.createElement('small');name.textContent=n.label;el.append(face,name);}list.append(el);
   if(n===center)return;
   const cx=mobile?center.mx:center.x,cy=mobile?center.my:center.y;
   const path=document.createElementNS('http://www.w3.org/2000/svg','path');path.id='edge-'+i;path.setAttribute('d',`M ${x*14.4} ${y*6.4} C ${x*14.4} ${cy*6.4}, ${cx*14.4} ${y*6.4}, ${cx*14.4} ${cy*6.4}`);if(i===2||i===3)path.classList.add('strong');edges.append(path);
 });
}
graph();addEventListener('resize',graph);
