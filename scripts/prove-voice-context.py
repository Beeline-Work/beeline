"""VOICE-CONTEXT-1: production voice runtime, disposable DB and actual RTC.
Run after prove-voice-delivery.ts. Providers and STT use controlled stand-ins.
Use --latency on fresh baseline/fixed fixtures after builds have stopped.
"""
import argparse
import json
import statistics
import time
import urllib.request
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument('--mode', choices=['baseline', 'fixed'], required=True)
parser.add_argument('--latency', action='store_true')
parser.add_argument('--round', default='1')
args = parser.parse_args()
output = Path('docs/voice-mode-proof/room-context')
output.mkdir(parents=True, exist_ok=True)

def request(path, body=None):
    req = urllib.request.Request('http://127.0.0.1:18097' + path,
        data=None if body is None else json.dumps(body).encode(),
        headers={'content-type': 'application/json'})
    return json.load(urllib.request.urlopen(req, timeout=40))

if args.latency:
    samples = []
    for turn in range(14):
        previous = len([s for s in request('/result')['signals'] if s.get('type') == 'latency'])
        request('/say', {'text': 'Ruby ready?', 'speechMs': 300, 'human': 'partner'})
        signals = [s for s in request('/result')['signals'] if s.get('type') == 'latency']
        assert len(signals) > previous, 'No first-audio signal received'
        if turn >= 4:
            samples.append(signals[-1]['firstAudioMs'])
        time.sleep(.5)
    result = {'mode': args.mode, 'samplesMs': samples, 'medianMs': statistics.median(samples),
        'warmupTurns': 4, 'path': 'Runtime end-of-turn to first voiced server audio, received by native RTC partner; controlled SSE and PCM'}
    (output / f'latency-{args.mode}-{args.round}.json').write_text(json.dumps(result, indent=2) + '\n')
else:
    value = request('/context-probe', {})
    history = value['brainHistories'][-1]
    recent = value['synthesis'][-2:]
    result = {'mode': args.mode, 'synthesis': recent,
        'otherAgentIncluded': any('Goosey suggests a picnic' in m['content'] for m in history),
        'attachmentIncluded': any('picnic.txt' in m['content'] for m in history),
        'cardIncluded': any('Picnic plan' in m['content'] for m in history),
        'history': history}
    assert result['otherAgentIncluded'] == (args.mode == 'fixed')
    assert result['attachmentIncluded'] == (args.mode == 'fixed')
    assert result['cardIncluded'] == (args.mode == 'fixed')
    if args.mode == 'fixed':
        assert recent[-1]['text'] == 'One complete sentence.'
    else:
        assert recent[-1]['text'] == 'Then a trailing fragment'
    (output / f'context-{args.mode}.json').write_text(json.dumps(result, indent=2) + '\n')
print(json.dumps({k:v for k,v in result.items() if k != 'history'}))
