"""Capture R1 in the complete, signed-in Android app on a leased emulator."""
import argparse
import json
from pathlib import Path
import re
import subprocess
import time
import urllib.request
import xml.etree.ElementTree as ET

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--device', required=True)
parser.add_argument('--surface', choices=['close', 'profile'], required=True)
parser.add_argument('--mode', choices=['offline-error', 'back'], required=True)
parser.add_argument('--out', required=True)
parser.add_argument('--proxy', default='http://127.0.0.1:18881')
a = parser.parse_args()
if not re.fullmatch(r'emulator-\d+', a.device):
    raise RuntimeError('A disposable, leased emulator is required')
if not a.proxy.startswith('http://127.0.0.1:'):
    raise RuntimeError('Network shaping must target the local fixture proxy')
out = Path(a.out)
out.mkdir(parents=True, exist_ok=True)
prefix = f'{a.surface}-{a.mode}'

def adb(*args):
    return subprocess.check_output(['adb', '-s', a.device, *args])

def nodes():
    adb('shell', 'uiautomator', 'dump', '/sdcard/deadline-proof.xml')
    return list(ET.fromstring(adb('shell', 'cat', '/sdcard/deadline-proof.xml')).iter('node'))

def find(rows, identifier):
    return next((n for n in rows if n.get('resource-id') == identifier), None)

def tap(node):
    x, y, right, bottom = map(int, re.findall(r'\d+', node.get('bounds')))
    adb('shell', 'input', 'tap', str((x + right) // 2), str((y + bottom) // 2))

def capture(suffix):
    (out / f'{prefix}-{suffix}.png').write_bytes(adb('exec-out', 'screencap', '-p'))

def shape(rtt):
    request = urllib.request.Request(a.proxy + '/__latency-rig/profile', method='POST',
        headers={'content-type': 'application/json'},
        data=json.dumps({'rttMs': rtt, 'jitterMs': 0, 'mbps': 10, 'failureRate': 0}).encode())
    with urllib.request.urlopen(request, timeout=5) as response:
        assert response.status == 204

rows = nodes()
if a.surface == 'close' and find(rows, 'corner-actions-menu') is not None:
    tap(find(rows, 'corner-actions-menu'))
    rows = nodes()
action_id = 'close-corner-action' if a.surface == 'close' else 'human-profile-message'
action = find(rows, action_id)
if action is None or action.get('enabled') != 'true':
    raise RuntimeError('Open the signed-in surface online and wait for its action: ' + action_id)
back = find(rows, 'close-human-profile')
capture('ready')
if a.mode == 'back':
    shape(10_000)
else:
    adb('shell', 'cmd', 'connectivity', 'airplane-mode', 'enable')
started = time.monotonic()
tap(action)
capture('pending')
try:
    if a.mode == 'back':
        adb('shell', 'cmd', 'connectivity', 'airplane-mode', 'enable')
        back_started = time.monotonic()
        if a.surface == 'profile':
            tap(back)
        else:
            adb('shell', 'input', 'keyevent', 'KEYCODE_BACK')
        rows = nodes()
        assert find(rows, action_id) is None, 'Back did not leave the pending surface'
        result = {'backVisibleBySeconds': round(time.monotonic() - back_started, 2)}
    else:
        while time.monotonic() - started < 25:
            rows = nodes()
            texts = [n.get('text') for n in rows if n.get('text')]
            errors = [text for text in texts if 'result is unknown' in text or 'Network request failed' in text]
            action = find(rows, action_id)
            # Android may retain an old "busy" content description after the
            # RN accessibility state clears. The enabled state proves retry.
            retry = find(rows, 'hull-alert-action-0') if a.surface == 'close' else action
            if errors and retry is not None and retry.get('enabled') == 'true':
                result = {'errorVisibleBySeconds': round(time.monotonic() - started, 2), 'errors': errors, 'retryEnabled': True}
                break
            time.sleep(.2)
        else:
            raise RuntimeError('No settled, retryable error within the observation limit: ' + str(texts))
    capture('result')
    (out / f'{prefix}.json').write_text(json.dumps({'reproduction': 'R1', 'surface': a.surface,
        'mode': a.mode, 'app': 'normal index.ts; real signed-in app; no transport mocks',
        'airplaneMode': True, **result}, indent=2) + '\n')
    print(json.dumps(result))
finally:
    adb('shell', 'cmd', 'connectivity', 'airplane-mode', 'disable')
    if a.mode == 'back':
        shape(100)
