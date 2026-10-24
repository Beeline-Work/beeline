"""Measure the controlled Android audio path; run after joining the proof call.

Usage: python3 scripts/measure-voice-speed.py EVENTS.jsonl RESULTS.jsonl COUNT
The observer and this driver use Linux CLOCK_MONOTONIC. No provider latency is
inferred. A missing audible onset fails instead of reporting RTC receipt as sound.
"""
import json
import sys
import time
import urllib.request

events_path, results_path, count = sys.argv[1:]
for _ in range(int(count)):
    started = time.monotonic_ns() / 1e6
    request = urllib.request.Request(
        'http://127.0.0.1:18297/say',
        data=json.dumps({'text': 'Ruby, say hello.', 'speechMs': 1000}).encode(),
        headers={'Content-Type': 'application/json'},
    )
    with urllib.request.urlopen(request, timeout=25) as response:
        response.read()
    time.sleep(1.2)
    with open(events_path) as source:
        events = [json.loads(line) for line in source if line.strip()]
    published = [e for e in events if e['event'] == 'published' and e['at'] >= started]
    if not published:
        raise RuntimeError('No PCM publication for this turn')
    sounds = [e for e in events if e['event'] == 'sound' and e['at'] >= published[0]['at']]
    if not sounds:
        raise RuntimeError('PCM published but no Android monitor onset')
    row = {'published': published[0]['at'], 'sound': sounds[0]['at'],
           'playbackMs': sounds[0]['at'] - published[0]['at'],
           'soundOnsets': len(sounds), 'publicationBursts': len(published),
           'monitorBatchMs': sounds[0]['batchMs']}
    with open(results_path, 'a') as output:
        output.write(json.dumps(row) + '\n')
    print(json.dumps(row), flush=True)
