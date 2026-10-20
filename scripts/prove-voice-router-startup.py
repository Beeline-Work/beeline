"""VOICE-ROUTER-1: Android startup against prove-voice-delivery.ts.

Controlled STT/brain/PCM, production hook and real native RTC. Start a fresh
fixture, launch the proof APK, then pass --device and --mode.
"""
import argparse
import json
import statistics
import subprocess
import time
import urllib.request
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument('--mode', choices=['baseline', 'fixed'], required=True)
parser.add_argument('--device', required=True)
args = parser.parse_args()
output = Path('docs/voice-mode-proof/router')
output.mkdir(parents=True, exist_ok=True)


def request(path, body=None):
    req = urllib.request.Request('http://127.0.0.1:18097' + path,
        data=None if body is None else json.dumps(body).encode(),
        headers={'content-type': 'application/json'})
    return json.load(urllib.request.urlopen(req, timeout=30))


def wait(check):
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        result = request('/result')
        if check(result):
            return result
        time.sleep(.05)
    raise AssertionError('Native observation timed out')


def adb(*words):
    return subprocess.check_output(['adb', '-s', args.device, *words])


def energy(observation):
    return max((row.get('totalAudioEnergy', 0)
        for row in observation.get('nativeAudio', [])), default=0)


adb('shell', 'input', 'tap', '875', '880')
result = wait(lambda r: any(o.get('event') == 'localTrackPublished'
    for o in r['observations']))
observations = result['observations']
tap = next(o['at'] for o in observations if o.get('event') == 'tap')
mic = next(o['at'] for o in observations if o.get('event') == 'localTrackPublished')
play = next(o['at'] for o in observations if o.get('canPlaybackAudio') and o['at'] >= tap)
samples = []
first = None
for _ in range(5):
    before = request('/result')
    previous_energy = max(map(energy, before['observations']), default=0)
    since = int(time.time() * 1000)
    request('/say', {'text': 'Ruby ready?', 'speechMs': 300})
    result = wait(lambda r: any(o['at'] >= since and energy(o) > previous_energy + .00001
        for o in r['observations']))
    heard = next(o['at'] for o in result['observations']
        if o['at'] >= since and energy(o) > previous_energy + .00001)
    first = first or heard
    samples.append(next(o['firstAudioMs'] for o in reversed(result['observations'])
        if o.get('firstAudioMs') is not None))
    time.sleep(.5)
record = {'mode': args.mode, 'device': args.device, 'tapToMicLiveMs': mic - tap,
    'tapToAudioPlayableMs': play - tap, 'tapToFirstAgentAudioMs': first - tap,
    'firstServerAudioMs': samples, 'medianFirstServerAudioMs': statistics.median(samples),
    'audioEnergyThreshold': .00001, 'observations': result['observations']}
(output / (args.mode + '-startup.json')).write_text(json.dumps(record, indent=2) + '\n')
(output / (args.mode + '-startup.png')).write_bytes(adb('exec-out', 'screencap', '-p'))
print(json.dumps({k: v for k, v in record.items() if k != 'observations'}))
