function checkPhoneHeroOverlap(){
 const hero=document.querySelector('#hero'), root=hero.getBoundingClientRect();
 const excluded='.wires,.wires *,svg,svg *,.native-codex-mark *,.scan-line,.sr-only,.sr-only *';
 const label=e=>e.id?'#'+e.id:e.tagName.toLowerCase()+'.'+[...e.classList].join('.');
 function rectangles(element){
  if(element.matches(excluded))return [];
  let p=element;
  while(p&&p!==document.documentElement){const s=getComputedStyle(p);if(s.display==='none'||s.visibility==='hidden'||Number(s.opacity)<.01||p.hidden)return [];p=p.parentElement;}
  return [...element.getClientRects()].map(r=>({left:r.left,top:r.top,right:r.right,bottom:r.bottom})).map(r=>{
   for(let p=element.parentElement;p&&p!==document.documentElement;p=p.parentElement){const s=getComputedStyle(p),b=p.getBoundingClientRect();if(/hidden|clip|scroll|auto/.test(s.overflowX)){r.left=Math.max(r.left,b.left);r.right=Math.min(r.right,b.right);}if(/hidden|clip|scroll|auto/.test(s.overflowY)){r.top=Math.max(r.top,b.top);r.bottom=Math.min(r.bottom,b.bottom);}}
   r.left=Math.max(r.left,0);r.right=Math.min(r.right,innerWidth);r.top=Math.max(r.top,0);r.bottom=Math.min(r.bottom,innerHeight);return r;
  }).filter(r=>r.right-r.left>.5&&r.bottom-r.top>.5);
 }
 const boxes=[...hero.querySelectorAll('*')].filter(e=>!e.closest('.native-room')||e.matches('textarea,input,[role=button],[role=progressbar]')||[...e.childNodes].some(n=>n.nodeType===3&&n.textContent.trim())).map(e=>({e,rects:rectangles(e)})).filter(x=>x.rects.length);
 const overlaps=[];
 for(let i=0;i<boxes.length;i++)for(let j=i+1;j<boxes.length;j++){
  const a=boxes[i],b=boxes[j];if(a.e.contains(b.e)||b.e.contains(a.e))continue;
  let collision;
  for(const ar of a.rects)for(const br of b.rects){const width=Math.min(ar.right,br.right)-Math.max(ar.left,br.left),height=Math.min(ar.bottom,br.bottom)-Math.max(ar.top,br.top);if(width>1&&height>1)collision={width:Math.round(width*100)/100,height:Math.round(height*100)/100};}
  if(collision)overlaps.push({a:label(a.e),b:label(b.e),...collision});
 }
 const critical=[...hero.querySelectorAll('.wordmark,.tagline,.primary-download,.other-platforms,.node .tile,.node .name,.screen,.hdr,.composer')].filter(e=>rectangles(e).length);
 const clipped=critical.filter(e=>{const b=e.getBoundingClientRect();return b.left<root.left-1||b.right>root.right+1||b.top<root.top-1||b.bottom>root.bottom+1;}).map(label);
 const escapedImages=[...hero.querySelectorAll('.av>img,.av>svg,.tile>img,.tile>svg,.native-codex-mark [data-testid=identity-face-plate] svg')].filter(e=>{const parent=e.closest('.native-codex-mark')||e.parentElement;if(!rectangles(parent).length)return false;const b=e.getBoundingClientRect(),p=parent.getBoundingClientRect();return b.left<p.left-1||b.right>p.right+1||b.top<p.top-1||b.bottom>p.bottom+1;}).map(label);
 const inline=hero.querySelector('.phone-inline-invite>.join-terminal');const inlineRects=inline?rectangles(inline):[];const inlineBounds=inline?.getBoundingClientRect();const fullInline=!!inlineBounds&&inlineRects.some(r=>r.right-r.left>=inlineBounds.width-1&&r.bottom-r.top>=inlineBounds.height-1);
 return {visibleAvatars:[...hero.querySelectorAll('.node')].filter(e=>rectangles(e).length).length,inlineInvitationFullyVisible:fullInline,floatingInvitationVisible:rectangles(document.querySelector('#join-terminal')).length>0,width:innerWidth,height:innerHeight,dpr:devicePixelRatio,touchPoints:navigator.maxTouchPoints,smallViewport:parseFloat(getComputedStyle(document.querySelector('#context')).height),heroHeight:root.height,landed:window.r7Demo?.state().landed,scene:window.r7Demo?.state().elapsed,visibleElements:boxes.length,overlaps,clipped,escapedImages,horizontalOverflow:document.documentElement.scrollWidth>innerWidth,watchVideoLinks:[...hero.querySelectorAll('a')].filter(a=>a.textContent.includes('Watch demo video')).length};
}
