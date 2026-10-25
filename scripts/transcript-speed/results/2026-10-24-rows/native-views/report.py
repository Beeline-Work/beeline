"""Render every alternating trial, without removing unfavorable samples."""
import gzip
import json
import pathlib
import statistics

root = pathlib.Path(__file__).parent
scenarios = ['history-prepend', 'optimistic-send', 'concurrent-streams', 'fling', 'scroll']
arms = {}
for arm in ['before', 'after']:
    trials = []
    for number in range(1, 4):
        source = root / arm / f'trial-{number}' / 'capture.json.gz'
        trials.append(json.loads(gzip.decompress(source.read_bytes())))
    arms[arm] = trials


def number(value):
    return 'unavailable' if value is None else f'{value:.2f}'.rstrip('0').rstrip('.')


lines = [
    '# Alternating row trials', '',
    'Order: before (1), after (1), before (2), after (2), before (3), after (3).',
    'Each arm resets scenario traffic and starts the supplied release APK.',
    'Hermes sampling is off; Fabric marker recording is on in both arms.',
    'No builds or tests ran during these captures. All trials are retained.', '',
    'JS columns measure frame intervals. Native columns are paired marker wall',
    'durations with millisecond precision. Commit, layout and mount overlap.', '',
]
for scenario in scenarios:
    lines.extend([
        f'## {scenario}', '',
        '| Arm/trial | JS p50/p95 (ms) | Worst JS (ms) | Missed JS | UI p95 (ms) | Row commits | Commit p50/p95 (ms) | Layout p50/p95 (ms) | Mount p50/p95 (ms) |',
        '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
    ])
    selected = {}
    for arm, trials in arms.items():
        selected[arm] = []
        for index, trial in enumerate(trials, 1):
            sample = next(s for s in trial['samples'] if s['scenario'] == scenario)
            selected[arm].append(sample)
            phase = lambda name: ' / '.join(number(sample['nativePhases'][name][key]) for key in ['p50Ms', 'p95Ms'])
            cells = [f'{arm} ({index})',
                     f'({number(sample["jsFrameIntervalP50Ms"])} / {number(sample["jsFrameIntervalP95Ms"])})',
                     f'({number(sample["jsFrameIntervalMaxMs"])})',
                     f'({sample["missedJsFrameOpportunities"]})',
                     f'({sample["uiFrames"]["p95Ms"]})', f'({sample["rowCommits"]})',
                     f'({phase("COMMIT")})', f'({phase("LAYOUT")})', f'({phase("BATCH_EXECUTION")})']
            lines.append('| ' + ' | '.join(cells) + ' |')
    lines.extend(['', 'Median across the three trials:', '',
                  '| Arm | Worst JS (ms) | Missed JS | UI p95 (ms) | Row commits |',
                  '| --- | ---: | ---: | ---: | ---: |'])
    for arm, samples in selected.items():
        values = [statistics.median([s[key] for s in samples]) for key in ['jsFrameIntervalMaxMs', 'missedJsFrameOpportunities']]
        values += [statistics.median([s['uiFrames']['p95Ms'] for s in samples]), statistics.median([s['rowCommits'] for s in samples])]
        lines.append('| ' + arm + ' | ' + ' | '.join(f'({number(value)})' for value in values) + ' |')
    lines.append('')
(root / 'TIMINGS.md').write_text('\n'.join(lines))
