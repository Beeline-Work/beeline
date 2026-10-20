"""VOICE-ROUTER-1: matched server first-audio measurement with native RTC.

Start a fresh scripts/prove-voice-delivery.ts fixture for each mode. For baseline,
set VOICE_DELIVERY_BASELINE=1 and place the original runtime in
apps/server/src/.voice-delivery-baseline.ts. No phone/emulator is required:
this records the runtime's latency signal received by the native RTC partner.
"""
import argparse
import json
import statistics
import time
import urllib.request
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument('mode', choices=['baseline', 'fixed'])
args = parser.parse_args()


def request(path, body=None):
    req = urllib.request.Request('http://127.0.0.1:18097' + path,
        data=None if body is None else json.dumps(body).encode(),
        headers={'content-type': 'application/json'})
    return json.load(urllib.request.urlopen(req, timeout=30))


for attempt in range(100):
    try:
        request('/result')
        break
    except OSError:
        if attempt == 99:
            raise
        time.sleep(.2)

samples = []
for turn in range(12):
    previous = len([s for s in request('/result')['signals'] if s.get('type') == 'latency'])
    request('/say', {'text': 'Ruby ready?', 'speechMs': 300})
    for attempt in range(100):
        signals = [s for s in request('/result')['signals'] if s.get('type') == 'latency']
        if len(signals) > previous:
            break
        time.sleep(.02)
    assert len(signals) > previous, 'No first-audio signal received'
    if turn >= 2:
        samples.append(signals[-1]['firstAudioMs'])
    time.sleep(.5)

result = {'mode': args.mode, 'samplesMs': samples, 'medianMs': statistics.median(samples),
    'warmupTurns': 2,
    'path': 'HTTP /say -> production runtime utterance -> PGlite commit -> controlled brain and PCM -> native LiveKit captureFrame -> latency signal received by native RTC partner'}
output = Path('docs/voice-mode-proof/router') / ('latency-' + args.mode + '.json')
output.write_text(json.dumps(result, indent=2) + '\n')
print(json.dumps(result))
