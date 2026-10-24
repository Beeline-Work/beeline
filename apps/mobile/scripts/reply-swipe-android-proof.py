"""Replay Reproduction swipe-1 on the leased 1080x2400/420dpi emulator.

Runs the reply screen of `scripts/transcript-dividers-native-proof.tsx`: a long
agent row that rerenders every 200 ms, with the keyboard opening on reply.
Each attempt swipes the row left (reply) or right (corner), waits for it to settle, then records where
the message body sits (UIAutomator bounds include transforms) and a screenshot.
At rest the body starts one ring pad (4dp) inside the Swipeable clip box.
"""
import argparse
import json
import re
import subprocess
import time
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument('--device', required=True)
parser.add_argument('--out', required=True)
parser.add_argument('--label', required=True)
args = parser.parse_args()
out = Path(args.out)
out.mkdir(parents=True, exist_ok=True)


def adb(*command):
    return subprocess.check_output(['adb', '-s', args.device, *command], timeout=60)


def bounds(test_id):
    adb('shell', 'uiautomator', 'dump', '/sdcard/swipe.xml')
    xml = adb('shell', 'cat', '/sdcard/swipe.xml').decode()
    match = re.search(rf'resource-id="{test_id}"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"', xml)
    return [int(value) for value in match.groups()] if match else None


def dismiss_keyboard():
    adb('shell', 'input', 'keyevent', '111')
    time.sleep(1)


assert '1080x2400' in adb('shell', 'wm', 'size').decode()
ATTEMPTS = [('fast-flick', 80, 900, 420), ('medium', 300, 900, 420), ('slow-drag', 900, 900, 420),
            ('corner-right', 300, 180, 660)]
results = []
for name, duration, start, end in ATTEMPTS:
    adb('shell', 'input', 'swipe', str(start), '1100', str(end), '1100', str(duration))
    time.sleep(2.5)
    clip = bounds('swipe-reply-long-agent')
    body = bounds('copy-message-long-agent')
    shot = out / f'{args.label}-{name}.png'
    shot.write_bytes(adb('exec-out', 'screencap', '-p'))
    # 4dp at 420dpi is 10.5px; allow one pixel of rounding.
    offset = body[0] - clip[0] - 10.5
    results.append({'attempt': name, 'durationMs': duration, 'clip': clip,
                    'body': body, 'bodyOffsetPx': offset, 'atRest': abs(offset) <= 1})
    dismiss_keyboard()
(out / f'{args.label}.json').write_text(json.dumps(results, indent=2) + '\n')
for result in results:
    print(result['attempt'], 'offset', result['bodyOffsetPx'], 'at rest' if result['atRest'] else 'STUCK')
