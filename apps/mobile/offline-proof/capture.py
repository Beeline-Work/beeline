"""Capture and assert the production route's native cache/failure/Retry path."""
import argparse
from pathlib import Path
import re
import subprocess
import time
import xml.etree.ElementTree as ET

parser = argparse.ArgumentParser()
parser.add_argument('device')
parser.add_argument('name')
parser.add_argument('--expect-notice', action='store_true')
parser.add_argument('--retry', action='store_true')
args = parser.parse_args()
evidence = Path(__file__).resolve().parent.parent / 'evidence/remove-offline-notice'

def adb(*parts):
    return subprocess.check_output(['adb', '-s', args.device, *parts])

def tree():
    result = adb('shell', 'uiautomator', 'dump', '/sdcard/offline-proof.xml')
    if b'UI hierchary dumped to' not in result:
        return b'<hierarchy />'
    return adb('shell', 'cat', '/sdcard/offline-proof.xml')

def wait_for(label, allow_launch=False):
    launches = 0
    for _ in range(12):
        xml = tree()
        if label in xml.decode():
            return xml
        if allow_launch and 'com.google.android.apps.nexuslauncher' in xml.decode() and launches < 2:
            adb('shell', 'am', 'start', '-a', 'android.intent.action.VIEW', '-d', 'exp://127.0.0.1:8197', 'host.exp.exponent')
            launches += 1
        if 'Toggle performance monitor' in xml.decode():
            adb('shell', 'input', 'keyevent', '4')
        if 'This is the developer menu.' in xml.decode():
            for node in ET.fromstring(xml).iter('node'):
                if node.get('text') == 'Continue':
                    x1, y1, x2, y2 = map(int, re.findall(r'\d+', node.get('bounds')))
                    adb('shell', 'input', 'tap', str((x1 + x2) // 2), str((y1 + y2) // 2))
        time.sleep(0.5)
    raise AssertionError(f'Production page did not show {label}')

def tap(label):
    root = ET.fromstring(wait_for(label))
    nodes = [node for node in root.iter('node') if node.get('text') == label or node.get('content-desc') == label]
    assert nodes, f'No exact native control: {label}'
    x1, y1, x2, y2 = map(int, re.findall(r'\d+', nodes[-1].get('bounds')))
    adb('shell', 'input', 'tap', str((x1 + x2) // 2), str((y1 + y2) // 2))

def capture(suffix, xml):
    (evidence / f'{args.name}{suffix}.xml').write_bytes(xml)
    (evidence / f'{args.name}{suffix}.png').write_bytes(adb('exec-out', 'screencap', '-p'))

wait_for('The saved conversation is still here.', allow_launch=True)
tap('Fail refresh')
xml = wait_for('Refresh failed: Network request failed')
if args.expect_notice:
    xml = wait_for('Offline — showing the last saved response.')
assert 'The saved conversation is still here.' in xml.decode()
assert ('Offline — showing the last saved response.' in xml.decode()) == args.expect_notice
capture('', xml)
print(f'{args.name}: cached transcript retained; offline notice={args.expect_notice}')
if args.retry:
    tap('Cold failed load')
    xml = wait_for('Could not load this conversation.')
    assert 'room-hydration-error' in xml.decode()
    assert 'The saved conversation is still here.' not in xml.decode()
    capture('-failed-load', xml)
    tap('Recover server')
    tap('Retry')
    xml = wait_for('The saved conversation is still here.')
    assert 'room-hydration-error' not in xml.decode()
    capture('-retry-recovered', xml)
    print(f'{args.name}: production failed-load screen and Retry recovery passed')
