const {execFileSync}=require('child_process');
const fs=require('fs');
const path=require('path');
const suffix=process.argv[2];
const pause=()=>new Promise(r=>setTimeout(r,1200));
const adb=(...a)=>execFileSync('adb',['-s','emulator-5562',...a],{maxBuffer:10*1024*1024});
const press=id=>execFileSync('node',[path.join(__dirname,'press.cjs'),id],{stdio:'inherit'});
const snap=name=>fs.writeFileSync(path.join(__dirname,'../../evidence/search-cells',`${name}-${suffix}.png`),adb('exec-out','screencap','-p'));
(async()=>{
 press('Connectors');await pause();snap('connectors');
 press('Rooms');await pause();snap('rooms');
 press('DM');await pause();snap('dm');press('direct-message-picker-close');await pause();
 press('Forward');await pause();snap('forward');press('forward-room-cancel');await pause();
 press('Repo');await pause();snap('repo');press('proof-repo-cancel');await pause();
 press('Profile');await pause();press('edit-agent-soul');await pause();
 adb('shell','input','swipe','500','2100','500','1000','450');await pause();snap('profile');
 press('model-axis-model');await pause();snap('model');
})();
