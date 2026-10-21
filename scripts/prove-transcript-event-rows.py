import argparse, subprocess, xml.etree.ElementTree as ET, re, time, pathlib, json, hashlib
parser = argparse.ArgumentParser(description='Capture and verify transcript event rows on a task-owned emulator')
parser.add_argument('--serial', required=True)
serial = parser.parse_args().serial
out=pathlib.Path('apps/mobile/evidence/transcript-event-rows')
def adb(*args):
    return subprocess.check_output(['adb','-s',serial,*args])
def nodes():
    adb('shell','uiautomator','dump','/sdcard/event-ui.xml')
    return ET.fromstring(adb('shell','cat','/sdcard/event-ui.xml')).iter('node')
def capture(name):
    out.joinpath(name+'.png').write_bytes(adb('exec-out','screencap','-p'))
    adb('shell','uiautomator','dump','/sdcard/event-ui.xml')
    out.joinpath(name+'.xml').write_bytes(adb('shell','cat','/sdcard/event-ui.xml'))
def tap(label):
    for node in nodes():
        if node.get('content-desc')==label or node.get('text')==label:
            x1,y1,x2,y2=map(int,re.findall(r'\d+',node.get('bounds')))
            adb('shell','input','tap',str((x1+x2)//2),str((y1+y2)//2));time.sleep(.4);return
    raise RuntimeError('Missing target: '+label)
def labels():
    return [n.get('text') or n.get('content-desc') for n in nodes() if n.get('text') or n.get('content-desc')]
print(json.dumps(labels(),ensure_ascii=False))
results={'serial':serial,'source':'real Room snapshot replay through production components','roomId':'bb91a1c7-7cad-4fde-aafc-94fccb651ac8'}
capture('android-collapsed')
tap('1 issue filed · 1 PR merged')
assert 'Open Issue #2722' in labels()
capture('android-expanded')
tap('Open Issue #2722')
assert 'https://github.com/Beeline-Work/beeline/issues/2722' in labels()
results['issue']='https://github.com/Beeline-Work/beeline/issues/2722'
tap('Open PR #2721')
assert 'https://github.com/Beeline-Work/beeline/pull/2721' in labels()
results['pr']='https://github.com/Beeline-Work/beeline/pull/2721'
tap('Open corner Show short schedule titles and mark one-time checks')
assert 'e683ae2a-5b60-41c3-875a-cabf3c1313d5' in labels()
results['corner']='e683ae2a-5b60-41c3-875a-cabf3c1313d5'
tap('1 issue filed · 1 PR merged')
assert 'Open Issue #2722' not in labels()
tap('Toggle original cards')
capture('android-before')
tap('Toggle original cards')
tap('Switch event run')
capture('android-corner-open')
assert any('Corner opened' in value for value in labels())
assert not any('Corner closed' in value for value in labels())
results['apkSha256']=hashlib.sha256(pathlib.Path('apps/mobile/android/app/build/outputs/apk/release/app-release.apk').read_bytes()).hexdigest()
out.joinpath('android-results.json').write_text(json.dumps(results,indent=2)+'\n')
print(json.dumps(results))
