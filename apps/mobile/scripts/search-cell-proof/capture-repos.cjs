const {execFileSync}=require('child_process');
const fs=require('fs');
const path=require('path');
const suffix=process.argv[2];
const pause=()=>new Promise(r=>setTimeout(r,1500));
const press=id=>execFileSync('node',[path.join(__dirname,'press.cjs'),id],{stdio:'inherit'});
(async()=>{for(const [label,name] of [['Repo','repo-phase2'],['New Room repos','new-room-repos'],['Repository choice','repository-choice']]){
 press(label);await pause();fs.writeFileSync(path.join(__dirname,'../../evidence/search-cells',`${name}-${suffix}.png`),execFileSync('adb',['-s','emulator-5562','exec-out','screencap','-p'],{maxBuffer:10*1024*1024}));
}})();
