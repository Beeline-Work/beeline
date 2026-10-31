"""Small adb driver for the dead-connection proof: find, tap, type, capture."""
import re
import subprocess
import sys
import time
import xml.etree.ElementTree as ET

DEVICE = 'emulator-5554'


def adb(*parts):
    return subprocess.check_output(['adb', '-s', DEVICE, *parts])


def nodes():
    for _ in range(3):
        out = adb('shell', 'uiautomator', 'dump', '/sdcard/proof-ui.xml')
        if b'dumped' in out:
            return list(ET.fromstring(adb('shell', 'cat', '/sdcard/proof-ui.xml')).iter('node'))
        time.sleep(0.3)
    return []


def label(node):
    return node.get('text') or node.get('content-desc') or ''


def find(text, exact=False):
    for node in nodes():
        value = label(node)
        if (value == text) if exact else (text in value):
            return node
    return None


def center(node):
    x1, y1, x2, y2 = map(int, re.findall(r'\d+', node.get('bounds')))
    return (x1 + x2) // 2, (y1 + y2) // 2


def tap(text, exact=False):
    node = find(text, exact)
    if node is None:
        raise SystemExit(f'not on screen: {text}')
    x, y = center(node)
    adb('shell', 'input', 'tap', str(x), str(y))
    print(f'{time.time():.3f} tapped {text!r} at {x},{y}')


def wait(text, seconds):
    started = time.time()
    while time.time() - started < seconds:
        if find(text) is not None:
            print(f'{time.time():.3f} saw {text!r} after {time.time() - started:.1f}s')
            return True
        time.sleep(0.5)
    print(f'{time.time():.3f} did not see {text!r} within {seconds}s')
    return False


def gone(text, seconds):
    started = time.time()
    while time.time() - started < seconds:
        if find(text) is None:
            print(f'{time.time():.3f} {text!r} gone after {time.time() - started:.1f}s')
            return True
        time.sleep(0.5)
    print(f'{time.time():.3f} {text!r} still shown after {seconds}s')
    return False


if __name__ == '__main__':
    command, *args = sys.argv[1:]
    if command == 'texts':
        print('\n'.join(label(n) for n in nodes() if label(n)))
    elif command == 'tap':
        tap(args[0], exact=len(args) > 1)
    elif command == 'wait':
        sys.exit(0 if wait(args[0], float(args[1])) else 1)
    elif command == 'gone':
        sys.exit(0 if gone(args[0], float(args[1])) else 1)
    elif command == 'type':
        adb('shell', 'input', 'text', args[0].replace(' ', '%s'))
    elif command == 'shot':
        open(args[0], 'wb').write(adb('exec-out', 'screencap', '-p'))
    elif command == 'back':
        adb('shell', 'input', 'keyevent', '4')
