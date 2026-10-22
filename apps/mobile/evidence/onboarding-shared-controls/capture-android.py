"""Capture production native screens using the isolated debug fixture entry."""
import json, os, subprocess, time
from pathlib import Path
import xml.etree.ElementTree as ET
import re
root=Path(__file__).resolve().parent
mobile=root.parent.parent
phase=os.environ.get('ONBOARDING_PHASE','after')
serial=os.environ.get('ONBOARDING_ANDROID_SERIAL','emulator-5554')
def adb(*args):
    return subprocess.check_output(['adb','-s',serial,*args])
screens=['sign-in','sign-in-error','profile','welcome&step=0','welcome&step=1','welcome&step=2','welcome&step=3','github','repository','starters','repository-choice&mode=none','repository-choice&mode=link','repository-choice&mode=create','repository-choice&mode=link&connected=0','repo-picker','agent-pending','agent-wait','agent-failed','agent-key','empty-room','workspace','workspace&join=1','create-workspace','invite','invite-offline','invite-unavailable','new-room','new-room-picker','repo-empty']
if os.environ.get('ONBOARDING_SCREENS'):screens=os.environ['ONBOARDING_SCREENS'].split(',')
out=root/phase/'android';out.mkdir(parents=True,exist_ok=True)
records=json.loads((out/'results.json').read_text()) if (out/'results.json').exists() else []
records=[r for r in records if r['screen'] not in screens]
counter=0
for theme in ['obsidian','bone']:
    for screen in screens:
        counter+=1
        if counter<=int(os.environ.get('ONBOARDING_SKIP','0')):continue
        query=f'screen={screen}&theme={theme}'
        adb('logcat','-c')
        adb('shell', f'am start -a android.intent.action.VIEW -d "beeline://onboarding-proof?{query}" -p app.usebeeline')
        time.sleep(.7)
        for attempt in range(15):
            logs=adb('logcat','-d','-s','ReactNativeJS').decode()
            if query in logs:break
            time.sleep(.5)
        time.sleep(.8)
        if screen.startswith('welcome'):
            step=int(screen.split('step=')[1])
            for _ in range(step):
                adb('shell','uiautomator dump /sdcard/onboarding.xml')
                xml=adb('shell','cat /sdcard/onboarding.xml').decode()
                nodes=ET.fromstring(xml).iter('node')
                next_node=next(n for n in nodes if n.attrib.get('text')=='Next' or n.attrib.get('content-desc')=='Next')
                nums=list(map(int,re.findall(r'\d+',next_node.attrib['bounds'])))
                adb('shell',f'input tap {(nums[0]+nums[2])//2} {(nums[1]+nums[3])//2}')
                time.sleep(.4)
        filename=screen.replace('&','-').replace('=','-')+'-'+theme+'.png'
        (out/filename).write_bytes(adb('exec-out','screencap','-p'))
        logs=adb('logcat','-d','-s','ReactNativeJS').decode()
        records.append({'screen':screen,'theme':theme,'file':filename,'errors':[line for line in logs.splitlines() if ' E ReactNativeJS' in line]})
        print(json.dumps({'phase':phase,'screen':screen,'theme':theme,'errors':records[-1]['errors']}),flush=True)
(out/'results.json').write_text(json.dumps(records,indent=2))
