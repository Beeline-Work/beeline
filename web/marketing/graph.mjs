export function initializeGraph(){

  const stage=document.getElementById('stage'), wrap=stage.parentElement;
  const wires=document.getElementById('wires'), screen=document.getElementById('screen');

  const nodeEls=[...document.querySelectorAll('.node')];
  const WIDE={w:1200,h:600,pw:760,ph:600}, TALL={w:380,h:650,pw:300,ph:420};
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
    if(F===TALL){stage.classList.add('phone');stage.style.setProperty('--s','1');wrap.style.height='auto';return;} stage.classList.remove('phone'); const available=innerHeight-document.querySelector('.hero-top').offsetHeight-48; const s=Math.min(1,wrap.clientWidth/F.w,Math.max(280,available)/F.h);
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
  function draw(){if(F===TALL){drawPhone();return;}
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
        const bounds=stage.getBoundingClientRect(),tile=n.querySelector('.tile').getBoundingClientRect(),scale=bounds.width/stage.clientWidth;
        const sx=((left?tile.right:tile.left)-bounds.left)/scale;
        const tileY=(tile.top+tile.height/2-bounds.top)/scale;
        const chan = left ? px - 46 - (k-1-i)*16 : px + pw + 46 + i*16;
        d = elbow(sx, tileY, chan, ey, ex, R);
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
  let frame;const redraw=()=>{cancelAnimationFrame(frame);frame=requestAnimationFrame(()=>{layout();draw();refreshActivity();});};
  addEventListener('resize',redraw);document.fonts.ready.then(redraw);
  const observer=new ResizeObserver(redraw);for(const element of [stage,screen,...nodeEls])observer.observe(element);


// Phone connections use the actual phone scene's CSS boxes, never the desktop
// diagram's unscaled coordinates or a guess based on window.innerHeight.
function drawPhone(){
 const bounds=stage.getBoundingClientRect(),room=screen.getBoundingClientRect();
 wires.setAttribute('viewBox',`0 0 ${stage.clientWidth} ${stage.clientHeight}`);wires.innerHTML='';geo=[];
 const agents=nodeEls.filter(n=>n.classList.contains('agent')),humans=nodeEls.filter(n=>n.classList.contains('human'));
 for(const n of nodeEls){
  const box=n.querySelector('.tile').getBoundingClientRect(),above=n.classList.contains('agent'),band=above?agents:humans,index=band.indexOf(n);
  const sx=box.left+box.width/2-bounds.left,sy=(above?box.bottom:box.top)-bounds.top;
  const ex=room.left-bounds.left+room.width/2+(index-(band.length-1)/2)*(above?54:94),ey=(above?room.top:room.bottom)-bounds.top;
  const channel=above?ey-6-(band.length-1-index)*4:ey+8+index*4;
  const d=velbow(sx,sy,channel,ex,ey,4),path=document.createElementNS('http://www.w3.org/2000/svg','path');
  path.setAttribute('d',d);path.dataset.actor=n.dataset.id;wires.appendChild(path);pad(ex,ey);geo.push({node:n,path,id:n.dataset.id,d});
 }
}


let active=[];function refreshActivity(){for(const g of geo){const on=active.includes(g.id);g.node.classList.toggle('live',on);g.path.classList.toggle('hot',on);}for(const e of document.querySelectorAll('.sidebar-person'))e.classList.toggle('active',active.includes(e.dataset.person));}
return {setActive(ids){active=ids;refreshActivity();},setConnected(on){stage.classList.toggle('codex-connected',on);document.querySelector('.node[data-id="codex"]').classList.toggle('not-joined',!on);}};
}
