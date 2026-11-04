"""Correlate proof-account ACTION_UP timestamps with native socket replies."""
import json
from pathlib import Path
import sys

root = Path(sys.argv[1])
versions = [('v142', 'v142-fault.ndjson', 'native142c-actions.jsonl'),
            ('pre3424', 'pre3424-probe.ndjson', 'pre3424-actions.jsonl'),
            ('fixed', 'fixed-probe.ndjson', 'fixed-actions.jsonl')]
results = {}
for version, trace, actions in versions:
    rows = [json.loads(line) for line in (root / trace).read_text().splitlines()]
    replies = {row['request']: row for row in rows if row.get('t') == 'res'}
    samples = []
    for action in map(json.loads, (root / actions).read_text().splitlines()):
        if 'tapLowerBound' not in action:
            continue
        touch = next(row for row in rows if row.get('event') == 'touch'
                     and row.get('x', 0) > 900
                     and action['tapLowerBound'] <= row['at'] <= action['tapLowerBound'] + 200)
        request = next(row for row in rows if row.get('op') == 'sendRoomMessage' and row['at'] >= touch['at'])
        reply = replies[request['request']]
        samples.append({'mode': action['mode'], 'touchAt': touch['at'], 'request': request['request'],
                        'dispatchAt': request['at'], 'ackAt': reply['at'],
                        'tapToAckMs': reply['at'] - touch['at'],
                        'tapToDispatchMs': request['at'] - touch['at'],
                        'newSocketsAroundSend': sum(row.get('event') == 'websocketOpen' and
                            touch['at'] - 1_000 <= row.get('at', 0) <= reply['at'] for row in rows)})
    results[version] = samples
print(json.dumps(results, indent=2))
