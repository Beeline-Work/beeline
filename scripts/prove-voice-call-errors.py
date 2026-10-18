"""CALL-ERROR-1 Android driver. Run against prove-voice-call-errors.ts on loopback."""
import argparse
import json
import re
import statistics
import subprocess
import time
import urllib.request
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument('--device', required=True)
parser.add_argument('--mode', choices=['baseline', 'fixed'], required=True)
args = parser.parse_args()
output = Path('docs/voice-mode-proof/call-error-policy')
output.mkdir(parents=True, exist_ok=True)
origin = 'http://127.0.0.1:18097'


def request(path, body=None):
    req = urllib.request.Request(origin + path, data=None if body is None else json.dumps(body).encode(),
                                 headers={'Content-Type': 'application/json'})
    return json.load(urllib.request.urlopen(req, timeout=40))


def until(check, label, timeout=20):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        result = request('/result')
        if check(result):
            return result
        time.sleep(.1)
    raise AssertionError(label)


def adb(*words):
    return subprocess.check_output(['adb', '-s', args.device, *words])


def native_rows(result):
    return [r for r in result['observations'] if 'joined' in r]


media_floor = 0

def media_samples(result):
    joined = next((r['at'] for r in native_rows(result) if r['joined']), float('inf'))
    return [r['nativeAudio'] for r in result['observations'] if r.get('nativeAudio') and r['at'] >= max(joined, media_floor)]


def packets(result):
    return max((sum(s.get('packetsReceived', 0) for s in rows) for rows in media_samples(result)), default=0)


def energy(result):
    return max((sum(s.get('totalAudioEnergy', 0) for s in rows) for rows in media_samples(result)), default=0)


def say(text='Ruby, ready?'):
    before = request('/result')
    native_before = native_rows(before)[-1].get('firstAudioMs')
    packet_before = packets(before)
    energy_before = energy(before)
    request('/say', {'text': text})
    result = until(lambda r: native_rows(r)[-1].get('firstAudioMs') not in [None, native_before]
                   and packets(r) > packet_before and energy(r) > energy_before + 0.00001, 'next reply must publish latency and arrive as Android RTP')
    return native_rows(result)[-1]['firstAudioMs']


def snapshot(result):
    return {key: result[key] for key in ['pid', 'callId', 'humans', 'participants', 'commands', 'faultEvents',
                                       'accessFailures', 'dispatchAttempts', 'frameCounts', 'signals', 'observations']}


for _ in range(600):
    try:
        request('/fixture')
        break
    except (OSError, ValueError):
        time.sleep(.1)
else:
    raise AssertionError('proof server unavailable')

adb('shell', 'am', 'force-stop', 'app.usebeeline')
adb('shell', 'am', 'start', '-n', 'app.usebeeline/.MainActivity')
until(lambda r: native_rows(r), 'Android fixture mounted')
time.sleep(1)
# Fixed API 36 fixture layout: the actual call card's Join control.
size = re.search(r'(\d+)x(\d+)', adb('shell', 'wm', 'size').decode())
width, height = map(int, size.groups())
adb('shell', 'input', 'tap', str(round(width * .81)), str(round(height * .367)))
start = until(lambda r: r['humans'] == 2 and native_rows(r) and native_rows(r)[-1]['joined'], 'Android joins real call')
latencies = [say() for _ in range(5)]
steps = []
if args.mode == 'baseline':
    steps.append(request('/fault', {'kind': 'access'}))
    result = until(lambda r: any(p['left_at'] is not None for p in r['participants']), 'original runtime wrongly removes a caller')
    assert result['pid'] == start['pid'] and result['callId'] == start['callId']
    (output / 'baseline-access-removal.png').write_bytes(adb('exec-out', 'screencap', '-p'))
else:
    def same_call():
        result = request('/result')
        assert result['pid'] == start['pid'] and result['callId'] == start['callId']
        assert result['humans'] == 2 and all(p['left_at'] is None for p in result['participants'])
        assert native_rows(result)[-1]['joined']
        return result
    for kind in ['access', 'heartbeat', 'error-signal', 'dispatch', 'brain', 'tts']:
        steps.append(request('/fault', {'kind': kind, 'text': 'Ruby, build a widget' if kind == 'dispatch' else 'Ruby, ready?'}))
        if kind in ['brain', 'tts']:
            expected = 8000 if kind == 'brain' else 5000
            assert expected <= steps[-1]['elapsedMs'] < expected + 3000, steps[-1]
            until(lambda r: native_rows(r)[-1].get('error'), 'recoverable error reaches Android')
            (output / (kind + '-recoverable-error.png')).write_bytes(adb('exec-out', 'screencap', '-p'))
        same_call()
        say()
    before_report = request('/result')
    received = packets(before_report)
    report_energy = energy(before_report)
    request('/report', {})
    result = until(lambda r: packets(r) > received and energy(r) > report_energy + 0.00001, 'later report reaches Android as audio')
    same_call()
    assert result['commands']['count'] == 1, result['commands']
    assert result['dispatchAttempts'] == 2, result['dispatchAttempts']
    assert all(steps[-1]['aborted']), steps[-1]
    (output / 'next-turn-and-report.png').write_bytes(adb('exec-out', 'screencap', '-p'))
    lease = request('/expire-worker', {})
    assert lease['pid'] == start['pid'] and lease['callId'] == start['callId']
    assert lease['previousClosed'] and lease['replaced'] and lease['endedAt'] is None
    steps.append({'kind': 'expired-worker', **lease})
    time.sleep(1.2)
    media_floor = max(r['at'] for r in request('/result')['observations']) + 1
    say()
    result = same_call()
    (output / 'lease-recovered.png').write_bytes(adb('exec-out', 'screencap', '-p'))
record = {'reproduction': 'CALL-ERROR-1', 'mode': args.mode,
          'standIn': 'Real Android production hook/VoiceBar and native RTC; PGlite database; injected STT final text, SSE and PCM provider responses. No live provider service is called.',
          'firstAudioMs': latencies, 'medianFirstAudioMs': statistics.median(latencies), 'steps': steps,
          'before': snapshot(start), 'after': snapshot(result)}
(output / (args.mode + '.json')).write_text(json.dumps(record, indent=2) + '\n')
print(json.dumps({'mode': args.mode, 'medianFirstAudioMs': record['medianFirstAudioMs'], 'pid': result['pid'],
                  'callId': result['callId'], 'humans': result['humans'], 'nativePackets': packets(result), 'steps': steps}))
