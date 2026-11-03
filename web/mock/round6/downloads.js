// Reuse the production detector; no user-agent or entitlement network request.
const platformNames={ios:'iOS',android:'Android',macos:'Mac',windows:'Windows',linux:'Linux'};
const detected=selectPlatform({userAgent:navigator.userAgent,platform:navigator.platform,maxTouchPoints:navigator.maxTouchPoints,uaDataPlatform:navigator.userAgentData?.platform});
for(const group of document.querySelectorAll('.smart-download')){
  const primary=group.querySelector('[data-primary-download]'),toggle=group.querySelector('.other-platforms'),list=group.querySelector('.other-platform-list');
  const destination=group.querySelector('[data-os="'+detected+'"]');
  if(destination){primary.href=destination.href;primary.textContent='Download for '+platformNames[detected];primary.dataset.detectedPlatform=detected;destination.hidden=true;}
  else {primary.textContent='Choose your platform';primary.removeAttribute('href');primary.setAttribute('role','button');primary.tabIndex=0;primary.onclick=()=>toggle.click();primary.onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();toggle.click();}};}
  toggle.onclick=()=>{const expanded=toggle.getAttribute('aria-expanded')==='true';toggle.setAttribute('aria-expanded',String(!expanded));list.hidden=expanded;};
  group.addEventListener('keydown',e=>{if(e.key==='Escape'){list.hidden=true;toggle.setAttribute('aria-expanded','false');toggle.focus({preventScroll:true});}});
}
window.r6DetectPlatform=selectPlatform;
