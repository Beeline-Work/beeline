"""R3: production hook/controls on Android, real RTC, disposable voice service.

Start prove-voice-delivery.ts with VOICE_PIN_PROOF=1 and
SILENCE_PROOF_ANDROID_FIRST=1; install the voice-delivery Android fixture.
"""
import argparse
import io
import json
from pathlib import Path
import subprocess
import threading
import time
import urllib.request
from PIL import Image

parser = argparse.ArgumentParser()
parser.add_argument('--device', required=True)
args = parser.parse_args()
output = Path('docs/voice-mode-proof/pinned-agent')
output.mkdir(parents=True, exist_ok=True)
records = []


def adb(*words):
    return subprocess.check_output(['adb', '-s', args.device, *words])


def request(path, body=None):
    req = urllib.request.Request('http://127.0.0.1:18097' + path,
        data=None if body is None else json.dumps(body).encode(),
        headers={'content-type': 'application/json'})
    return json.load(urllib.request.urlopen(req, timeout=30))


def observation():
    return [row for row in request('/result')['observations'] if 'target' in row][-1]


def until(check, label):
    for _ in range(100):
        try:
            row = observation()
            if check(row):
                return row
        except (IndexError, OSError):
            pass
        time.sleep(.2)
    raise AssertionError(label)


def screenshot():
    return adb('exec-out', 'screencap', '-p')


def capture(name, target, speaker=None):
    row = until(lambda row: row.get('target') == target and row.get('speaker') == speaker, name)
    time.sleep(.25)
    (output / (name + '.png')).write_bytes(screenshot())
    records.append({'state': name, 'target': row['target'], 'speaker': row['speaker'], 'joined': row['joined']})


def tap_avatar(index, expected):
    image = Image.open(io.BytesIO(screenshot())).convert('RGB')
    # Locate the fixture's pink Ruby face; the strip can move as pin text appears.
    rows = [y for y in range(image.height // 2, image.height - 100)
        if (lambda rgb: rgb[0] > rgb[1] * 1.2 and rgb[2] > rgb[1] * 1.2 and rgb[0] > 130)(image.getpixel((75, y)))]
    assert rows, 'agent strip missing'
    adb('shell', 'input', 'tap', str(100 + index * 144), str((min(rows) + max(rows)) // 2))
    until(lambda row: row.get('target') == expected, 'avatar tap did not change the pin')


def theme(name):
    image = Image.open(io.BytesIO(screenshot())).convert('RGB')
    light = sum(image.getpixel((10, 200))) > 500
    if light == (name == 'bone'):
        return
    runs = []
    start = None
    for y in range(600, 2000):
        total = sum(image.getpixel((70, y)))
        button = total < 150 if light else total > 600
        if button and start is None:
            start = y
        if not button and start is not None:
            if y - start >= 70:
                runs.append((start, y))
            start = None
    assert len(runs) >= 2, runs
    top, bottom = runs[0 if name == 'bone' else 1]
    adb('shell', 'input', 'tap', '540', str((top + bottom) // 2))
    time.sleep(.5)


adb('shell', 'am', 'force-stop', 'app.usebeeline')
adb('shell', 'am', 'start', '-n', 'app.usebeeline/.MainActivity')
until(lambda row: not row['joined'], 'fixture mounted')
for attempt in range(10):
    adb('shell', 'input', 'tap', '875', '880')
    time.sleep(1)
    if observation()['joined']:
        break
until(lambda row: row['joined'], 'Android joined')
ruby, goose = 'b' * 64, 'c' * 64
for material in ['bone', 'obsidian']:
    theme(material)
    capture(material + '-default', None)
    tap_avatar(0, ruby)
    capture(material + '-pinned', ruby)
    tap_avatar(0, None)
    capture(material + '-tap-unpinned', None)
    tap_avatar(0, ruby)
    speaking = threading.Thread(target=lambda: request('/say', {'text': 'Ready?', 'speechMs': 6000}))
    speaking.start()
    until(lambda row: row.get('speaker') == ruby, 'pinned agent speaks')
    capture(material + '-speaking', ruby, ruby)
    speaking.join()
    until(lambda row: row.get('speaker') is None, 'speech finished')
    transcript = request('/result')['transcript']
    assert any(row['author'] == 'a' * 64 and row['text'] == '@ruby Ready?' for row in transcript)
    tap_avatar(1, goose)
    capture(material + '-moved', goose)
    adb('shell', 'input', 'tap', '1000', '2200')
    until(lambda row: row.get('target') is None, 'Unpin link clears the pin')
    capture(material + '-link-unpinned', None)
(output / 'android.json').write_text(json.dumps({'reproduction': 'R3', 'states': records,
    'standIn': 'Built production hook and VoiceBar on Android; disposable PGlite and controlled providers over native LiveKit. Fixture keeps the call open for capture.'}, indent=2) + '\n')
print(json.dumps(records))
