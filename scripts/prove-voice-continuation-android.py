"""CONVERSATION-1/2: production Android call UI + real RTC + controlled providers."""
import argparse
import json
import statistics
import subprocess
import time
import urllib.request
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument('--device', required=True)
parser.add_argument('--mode', choices=['baseline', 'fixed'], required=True)
args = parser.parse_args()
output = Path('docs/voice-mode-proof/conversation-continuation')
output.mkdir(parents=True, exist_ok=True)
H = 'a' * 64

def request(path, body=None):
    req = urllib.request.Request('http://127.0.0.1:18097' + path,
        data=None if body is None else json.dumps(body).encode(), headers={'Content-Type': 'application/json'})
    return json.load(urllib.request.urlopen(req, timeout=40))

def until(check, label, timeout=30):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        try:
            value = request('/result')
        except OSError:
            time.sleep(.1)
            continue
        if check(value):
            return value
        time.sleep(.1)
    raise AssertionError(label)

def adb(*words):
    return subprocess.check_output(['adb', '-s', args.device, *words])

def tap(label):
    # The release fixture's 1080x2400 layout is recorded in the proof screenshots.
    # Its live native audio updates keep UIAutomator's idle detector busy.
    x, y = {'Join': (875, 880), 'Speak to Goosey': (180, 2145)}[label]
    adb('shell', 'input', 'tap', str(x), str(y))

def segment(text):
    request('/segment', {'text': text})

def human_rows(value):
    return [row for row in value['transcript'] if row['author'] == H]

def native(value):
    return [row for row in value['observations'] if 'joined' in row]

def energy(value):
    return max((sum(row.get('totalAudioEnergy', 0) for row in observation['nativeAudio'])
        for observation in value['observations'] if observation.get('nativeAudio')), default=0)

until(lambda value: value['callId'], 'server ready')
launched_at = int(time.time() * 1000)
adb('shell', 'am', 'force-stop', 'app.usebeeline')
adb('shell', 'am', 'start', '-n', 'app.usebeeline/.MainActivity')
until(lambda value: any(row['at'] >= launched_at for row in native(value)), 'fixture mounted')
time.sleep(1)
tap('Join')
until(lambda value: bool(native(value)) and native(value)[-1]['joined'], 'Android joined')
request('/solo-proof', {})
until(lambda value: value['humans'] == 1, 'solo call')
latencies = []
for _ in range(5):
    request('/say', {'text': 'Ruby ready?'})
    time.sleep(.15)
    latencies.append(native(request('/result'))[-1]['firstAudioMs'])
time.sleep(1)
before = request('/result')
before_rows = len(human_rows(before))
before_commands = before['commands']['count']
initial_energy = energy(before)
request('/speech-gate', {'hold': True})
segment('Ruby build a clock')
until(lambda value: value['decisionRequests'] == before['decisionRequests'] + 1, 'first brain decision completes immediately')
if args.mode == 'baseline':
    until(lambda value: value['commands']['count'] == before_commands + 1, 'baseline dispatch commits immediately')
time.sleep(1.2)
segment('and build an alarm')
time.sleep(1.8)
segment('and build a timer')
time.sleep(.4)
assembled = request('/result')
rows = human_rows(assembled)[before_rows:]
if args.mode == 'fixed':
    assert assembled['commands']['count'] == before_commands, assembled['commandDetails']
    assert assembled['decisionRequests'] == before['decisionRequests'] + 3
    assert len(rows) == 1 and rows[0]['text'] == '@ruby Ruby build a clock and build an alarm and build a timer', rows
else:
    assert len(rows) == 3 and assembled['commands']['count'] == before_commands + 3, rows
assert len(assembled['synthesis']) == len(before['synthesis']), 'No new speech bytes before the gate opens'
request('/speech-gate', {'hold': False})
until(lambda value: energy(value) > initial_energy + .00001, 'Android receives actual reply audio')
committed = request('/result')
assert committed['commands']['count'] == before_commands + (1 if args.mode == 'fixed' else 3)
(output / (args.mode + '-joined.png')).write_bytes(adb('exec-out', 'screencap', '-p'))
if args.mode == 'fixed':
    request('/report', {})
    until(lambda value: any(row['text'] == 'The work is done.' for row in value['transcript']), 'committed command reports')
    tap('Speak to Goosey')
    time.sleep(4)
    segment('build one more clock')
    targeted = until(lambda value: value['commands']['count'] == before_commands + 2, 'tap survives four seconds')
    assert targeted['commandDetails'][-1]['agent_id'] == 'c' * 64
    (output / 'fixed-selected.png').write_bytes(adb('exec-out', 'screencap', '-p'))
record = {'reproduction': 'CONVERSATION-1', 'mode': args.mode,
    'rowsForPausedRequest': rows, 'commandsForPausedRequest': committed['commands']['count'] - before_commands,
    'decisionsForPausedRequest': assembled['decisionRequests'] - before['decisionRequests'], 'firstAudioMs': latencies, 'medianFirstAudioMs': statistics.median(latencies),
    'result': request('/result'),
    'standIn': 'Built production Android hook/VoiceBar with native RTC, disposable PGlite, controlled Flux finals and provider SSE/PCM. No physical speech or speaker latency measurement.'}
(output / (args.mode + '-android.json')).write_text(json.dumps(record, indent=2) + '\n')
print(json.dumps({key: record[key] for key in ['mode', 'commandsForPausedRequest', 'rowsForPausedRequest', 'firstAudioMs', 'medianFirstAudioMs']}))
