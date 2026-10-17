"""Capture the isolated native fixture; successful sends use simulated receipts."""
import argparse
import json
from pathlib import Path
import re
import subprocess
import xml.etree.ElementTree as ET

parser = argparse.ArgumentParser()
parser.add_argument('--device', required=True)
parser.add_argument('--out', required=True)
args = parser.parse_args()
out = Path(args.out)
out.mkdir(parents=True, exist_ok=True)
results = {}


def adb(*command):
    return subprocess.check_output(['adb', '-s', args.device, *command])


def dump():
    adb('shell', 'uiautomator', 'dump', '/sdcard/placeholder-proof.xml')
    return ET.fromstring(adb('exec-out', 'cat', '/sdcard/placeholder-proof.xml'))


def bounds(node):
    return list(map(int, re.findall(r'\d+', node.get('bounds', ''))))


def tap(label):
    root = dump()
    node = next(n for n in root.iter('node') if n.get('content-desc') == label)
    x1, y1, x2, y2 = bounds(node)
    adb('shell', 'input', 'tap', str((x1+x2)//2), str((y1+y2)//2))


def capture(name, count, placeholder):
    root = dump()
    hints = [n for n in root.iter('node') if n.get('text', '').strip() == 'No agent was tagged']
    assert len(hints) == count, (name, len(hints), count)
    inputs = [n.get('text') for n in root.iter('node') if n.get('class') == 'android.widget.EditText']
    assert inputs == [placeholder], (name, inputs)
    second = next(n for n in root.iter('node') if n.get('text') == 'Second account device')
    assert all(bounds(n)[3] <= bounds(second)[1] for n in hints), name
    (out / (name + '.png')).write_bytes(adb('exec-out', 'screencap', '-p'))
    results[name] = {'senderHints': len(hints), 'secondAccountHints': 0, 'placeholder': placeholder}
    print(name, results[name], flush=True)


for theme in ['bone', 'obsidian']:
    tap('Room')
    capture(theme + '-empty', 0, 'Tag an agent with @')
    tap('Untagged')
    capture(theme + '-untagged', 1, 'Tag an agent with @')
    tap('Tag person')
    capture(theme + '-tagged-person', 0, 'Tag an agent with @')
    tap('Room')
    tap('Untagged')
    tap('Tag agent')
    capture(theme + '-tagged-agent', 0, 'Tag an agent with @')
    tap('Room')
    tap('Untagged')
    tap('Leave / return')
    capture(theme + '-left', 0, 'Tag an agent with @')
    tap('Leave / return')
    capture(theme + '-returned', 0, 'Tag an agent with @')
    tap('DM')
    tap('Untagged')
    capture(theme + '-dm', 0, 'Message')
    tap('No agents')
    tap('Untagged')
    capture(theme + '-no-agents', 0, 'Message')
    tap('Corner')
    tap('Untagged')
    capture(theme + '-corner', 1, 'Tag an agent with @')
    tap('Room')
    if theme == 'bone':
        tap('Toggle theme')
(out / 'hint-results.json').write_text(json.dumps(results, indent=2) + '\n')
