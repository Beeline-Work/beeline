"""Drive the voice-multi-tips Android fixture; capture tip-line states."""
import argparse, re, subprocess, time
import xml.etree.ElementTree as ET
from pathlib import Path
p = argparse.ArgumentParser()
p.add_argument('--device', required=True)
p.add_argument('--out', required=True)
a = p.parse_args()
out = Path(a.out); out.mkdir(parents=True, exist_ok=True)
TIPS = ['Start with a name: “Ruby, …”', 'Tap an avatar to talk to it once', 'Talk over an agent to stop it']
LABEL = 'Conversation mode'
log = []
def adb(*args):
    return subprocess.check_output(['adb', '-s', a.device, *args])
try:
    import uiautomator2
    U2 = uiautomator2.connect(a.device)
except ImportError:
    U2 = None
def nodes():
    # The live waveform re-renders every 120 ms, so `uiautomator dump` rarely
    # reaches idle; uiautomator2 reads the same accessibility tree without waiting.
    if U2 is not None:
        return list(ET.fromstring(U2.dump_hierarchy()).iter('node'))
    for _ in range(15):
        adb('shell', 'rm', '-f', '/sdcard/tips.xml')
        dumped = adb('shell', 'uiautomator', 'dump', '/sdcard/tips.xml')
        if b'dumped to' in dumped:
            return list(ET.fromstring(adb('shell', 'cat', '/sdcard/tips.xml')).iter('node'))
    raise SystemExit('uiautomator never reached idle')
def line(ns):
    hits = [n for n in ns if n.get('text') in TIPS + [LABEL]]
    return [(n.get('text'), n.get('bounds')) for n in hits]
def header(ns):
    return next(n.get('text') for n in ns if (n.get('text') or '').startswith('Voice tips proof'))
def tap(label):
    n = next(n for n in nodes() if n.get('content-desc') == label or n.get('text') == label)
    x1, y1, x2, y2 = map(int, re.findall(r'\d+', n.get('bounds')))
    adb('shell', 'input', 'tap', str((x1 + x2) // 2), str((y1 + y2) // 2))
def shot(name):
    (out / (name + '.png')).write_bytes(adb('exec-out', 'screencap', '-p'))
def record(name, ns, note=''):
    log.append(f'[{name}] {header(ns)}{note}')
    for text, bounds in line(ns):
        log.append(f'  tip-line text={text!r} bounds={bounds}')
    if not line(ns):
        log.append('  tip-line: NOT FOUND')
def capture_tip(name, want, deadline=20):
    end = time.time() + deadline
    while time.time() < end:
        before = line(nodes())
        if before and before[0][0] == want:
            shot(name)
            ns = nodes()
            if line(ns) and line(ns)[0][0] == want:
                record(name, ns, ' (dump before and after screencap agree)')
                return
        time.sleep(.3)
    raise SystemExit(f'{name}: never saw {want!r}')
tap('Two humans'); time.sleep(.5)
capture_tip('android-two-humans-tip1', TIPS[0])
capture_tip('android-two-humans-tip2', TIPS[1])
capture_tip('android-two-humans-tip3', TIPS[2])
tap('Dropped turn')
t0 = time.time(); shot('android-dropped-turn-flash'); dt = time.time() - t0
ns = nodes()
record('android-dropped-turn-flash', ns, f' (screencap within {dt:.2f}s of tap; dump taken after; flash colour verified visually only)')
tap('One human'); time.sleep(.8)
shot('android-one-human-label')
record('android-one-human-label', nodes())
(out / 'android-ui.txt').write_text('\n'.join(log) + '\n')
print('\n'.join(log))
