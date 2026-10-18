"""DELIVERY-2: built Android RTC call with controlled STT and provider responses."""
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
output = Path('docs/voice-mode-proof/request-delivery')
output.mkdir(parents=True, exist_ok=True)

def request(path, body=None):
    req = urllib.request.Request('http://127.0.0.1:18097' + path,
        data=None if body is None else json.dumps(body).encode(), headers={'Content-Type': 'application/json'})
    return json.load(urllib.request.urlopen(req, timeout=40))

def until(check, label, timeout=25):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        try:
            result = request('/result')
        except OSError:
            time.sleep(.1)
            continue
        if check(result):
            return result
        time.sleep(.1)
    raise AssertionError(label)

def adb(*words):
    return subprocess.check_output(['adb', '-s', args.device, *words])

def count(result):
    return result['commands']['count']

def segment(text, human='native'):
    request('/segment', {'text': text, 'human': human})
    time.sleep(.2)

def native(result):
    return [row for row in result['observations'] if 'joined' in row]

def energy(result):
    return max((sum(s.get('totalAudioEnergy', 0) for s in row['nativeAudio'])
        for row in result['observations'] if row.get('nativeAudio')), default=0)

def report():
    before = energy(request('/result'))
    request('/report', {})
    return until(lambda r: energy(r) > before + .00001 and any(m['text'] == 'The work is done.' for m in r['transcript']), 'provenance-bound report received on Android')

until(lambda r: r.get('callId'), 'isolated server ready')
adb('shell', 'am', 'force-stop', 'app.usebeeline')
adb('shell', 'am', 'start', '-n', 'app.usebeeline/.MainActivity')
until(lambda r: native(r), 'fixture mounted')
time.sleep(1)
adb('shell', 'input', 'tap', '875', '880')
start = until(lambda r: r['humans'] == 2 and native(r)[-1]['joined'], 'Android joins actual call')
latencies = []
for _ in range(5):
    request('/say', {'text': 'Ruby ready?'})
    latencies.append(native(request('/result'))[-1]['firstAudioMs'])
steps = []
if args.mode == 'baseline':
    request('/delivery-fault', {'kind': 'tts-fail'})
    # A direct addressed work request reproduces the lost command on failed TTS.
    segment('Ruby check my latest report')
    result = until(lambda r: native(r)[-1].get('error'), 'baseline TTS error reaches Android')
    assert count(result) == 0
    steps.append({'scenario': 'TTS failure', 'commands': count(result), 'error': native(result)[-1]['error']})
else:
    for scenario in ['name-pause-interruption', 'tts-failure', 'avatar-tap']:
        before = request('/result')
        if scenario == 'avatar-tap':
            # Tap Goosey's actual production VoiceBar tile (coordinates recorded with screenshot).
            adb('shell', 'input', 'tap', '180', '2145')
            time.sleep(.3)
        else:
            segment('Ruby')
            time.sleep(2)
        if scenario == 'name-pause-interruption':
            request('/brain-gate', {'hold': True})
        if scenario == 'tts-failure':
            request('/delivery-fault', {'kind': 'tts-fail'})
        segment('check my latest report')
        if scenario == 'name-pause-interruption':
            until(lambda r: r['decisionRequests'] > before['decisionRequests'], 'classification started')
            segment('Goosey ready?', 'partner')
            request('/brain-gate', {'hold': False})
        result = until(lambda r: count(r) == count(before) + 1, 'exactly one command committed')
        expected = 'c' * 64 if scenario == 'avatar-tap' else 'b' * 64
        new_orders = [o for o in result['orders'] if o['source_message_id'] not in {p['source_message_id'] for p in before['orders']}]
        assert len(new_orders) == 1 and new_orders[0]['agent_id'] == expected, new_orders
        time.sleep(.4)
        if scenario == 'tts-failure':
            until(lambda r: native(r)[-1].get('error'), 'TTS error reaches Android after commit')
        result = report()
        assert count(result) == count(before) + 1
        steps.append({'scenario': scenario, 'sourceId': new_orders[0]['source_message_id'], 'agentId': expected,
            'commands': count(result), 'reportReceived': True})
        (output / (scenario + '.png')).write_bytes(adb('exec-out', 'screencap', '-p'))
    before = count(request('/result'))
    segment('Ruby')
    time.sleep(3.2)
    segment('check my latest report')
    time.sleep(.4)
    assert count(request('/result')) == before
    steps.append({'scenario': 'expired-name', 'noCommand': True})
    segment('Ruby')
    segment('Goosey check my latest report')
    result = until(lambda r: count(r) == before + 1, 'explicit retarget delivers once')
    newest = next(o for o in result['orders'] if o['spoken_message_id'] is None)
    assert newest['agent_id'] == 'c' * 64
    report()
    steps.append({'scenario': 'retarget', 'agentId': newest['agent_id'], 'commands': count(result)})
result = request('/result')
assert result['pid'] == start['pid'] and result['callId'] == start['callId'] and result['humans'] == 2
record = {'reproduction': 'DELIVERY-2', 'mode': args.mode, 'firstAudioMs': latencies,
    'medianFirstAudioMs': statistics.median(latencies), 'steps': steps, 'result': result,
    'standIn': 'Built production Android hook/VoiceBar with native RTC, disposable PGlite, controlled STT finals and provider SSE/PCM; commands and provenance-bound reports use actual server routing.'}
(output / (args.mode + '.json')).write_text(json.dumps(record, indent=2) + '\n')
print(json.dumps({'mode': args.mode, 'steps': steps, 'firstAudioMs': latencies, 'pid': result['pid'], 'callId': result['callId']}))
