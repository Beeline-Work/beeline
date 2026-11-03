// Phone connections use the actual phone scene's CSS boxes, never the desktop
// diagram's unscaled coordinates or a guess based on window.innerHeight.
function drawPhone(){
 const bounds=stage.getBoundingClientRect(),room=screen.getBoundingClientRect();
 wires.setAttribute('viewBox',`0 0 ${stage.clientWidth} ${stage.clientHeight}`);wires.innerHTML='';geo=[];
 const agents=nodeEls.filter(n=>n.classList.contains('agent')),humans=nodeEls.filter(n=>n.classList.contains('human'));
 for(const n of nodeEls){
  const box=n.getBoundingClientRect(),above=n.classList.contains('agent'),band=above?agents:humans,index=band.indexOf(n);
  const sx=box.left+box.width/2-bounds.left,sy=(above?box.bottom+2:box.top-2)-bounds.top;
  const ex=room.left-bounds.left+room.width/2+(index-(band.length-1)/2)*(above?54:94),ey=(above?room.top:room.bottom)-bounds.top;
  const channel=above?ey-6-(band.length-1-index)*4:ey+8+index*4;
  const d=velbow(sx,sy,channel,ex,ey,4),path=document.createElementNS('http://www.w3.org/2000/svg','path');
  path.setAttribute('d',d);path.dataset.actor=n.dataset.id;wires.appendChild(path);pad(ex,ey);geo.push({node:n,path,id:n.dataset.id,d});
 }
}
