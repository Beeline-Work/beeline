"""R1 native stand-in: shipped header and scroll controller, synthetic blockers."""
import re
import subprocess
from pathlib import Path
import xml.etree.ElementTree as ET

DEVICE = 'emulator-5558'
OUT = Path(__file__).resolve().parent.parent / 'evidence/corner-waiting-header'
def adb(*args):
    return subprocess.check_output(['adb', '-s', DEVICE, *args])
def tree():
    adb('shell', 'uiautomator', 'dump', '/sdcard/hold-proof.xml')
    return adb('shell', 'cat', '/sdcard/hold-proof.xml')
def tap(label):
    nodes = [n for n in ET.fromstring(tree()).iter('node') if n.get('text') == label or n.get('content-desc') == label]
    assert nodes, label
    x1,y1,x2,y2 = map(int,re.findall(r'\d+',nodes[-1].get('bounds')))
    adb('shell','input','tap',str((x1+x2)//2),str((y1+y2)//2))
def capture(name):
    xml=tree()
    (OUT/f'{name}.xml').write_bytes(xml)
    (OUT/f'{name}.png').write_bytes(adb('exec-out','screencap','-p'))
    return xml
assert adb('shell','settings','get','system','font_scale').strip() == b'1.3'
if b'Show original projection' in tree(): tap('Show original projection')
tap('approve')
assert b'Jump requested for hold UUID; no message reached' in tree()
capture('android-before-font-1.3')
tap('Show fixed projection')
xml=tree()
assert b'RUBY' in xml and b'waiting on your merge hold' in xml
for n in ET.fromstring(xml).iter('node'):
    if 'merge hold' in n.get('text','') or 'waiting on a report' in n.get('text',''):
        assert n.get('clickable') == 'false'
        assert len(list(n)) == 0
# A tap at the held header has no action.
tap('RUBY · waiting on your merge hold')
assert b'No message reached' in tree()
capture('android-after-font-1.3')
tap('approve')
assert b'Approval message reached' in tree()
capture('android-message-jump-font-1.3')
print('R1 PASS: hold/report plain text; hold tap inert; real message jump preserved; font scale 1.3')
