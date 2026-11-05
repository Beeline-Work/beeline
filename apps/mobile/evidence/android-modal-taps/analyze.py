"""Recompute Android modal/cold-start diagnostics from sanitized capture records."""
import argparse
import gzip
import json
import re
import statistics
from pathlib import Path

ROOT = Path(__file__).resolve().parent


def marks(log):
    result = []
    for line in log.splitlines():
        if '[PHONE_TAPS] ' not in line:
            continue
        result.extend(json.loads(line.split('[PHONE_TAPS] ', 1)[1]))
    return result


def frames(source):
    header = None
    result = []
    for line in source.splitlines():
        if line.startswith('Flags,'):
            header = line.rstrip(',').split(',')
        elif header and re.match(r'^\d+,', line):
            row = dict(zip(header, map(int, line.rstrip(',').split(','))))
            # Android 15: bit 0 is WindowVisibilityChanged, bit 3 SkippedFrame.
            # First draws can set bit 0. Require complete, ordered timestamps.
            if not row['Flags'] & 8 and 0 < row['DrawStart'] <= row['FrameCompleted'] < 10**18:
                result.append(row)
    return result


def first_frame(rows, after):
    return min((r['FrameCompleted'] / 1e6 for r in rows if r['DrawStart'] / 1e6 >= after), default=None)


def summarize(raw):
    rs = marks(raw['log'])
    fs = frames(raw['gfx'])
    native = raw['nativeSlices']
    result = {k: raw[k] for k in ['arm', 'kind', 'sample']}
    if raw['kind'] == 'sheet':
        tap = next(r['ts'] for r in native if 'ACTION_UP' in r['name'])
        layout = next(r['ts'] for r in native if 'relayoutWindow#first=true' in r['name'])
        handler = next((r['t'] for r in rs if r['phase'] == 'sheet-tap'), None)
        commit = next((r['t'] for r in rs if r['phase'] == 'sheet-commit'), None)
        draw = first_frame(fs, max(layout, commit or layout))
        result['nativeFrameProxyMs'] = None if draw is None else draw - tap
        if commit is not None:
            result['contentCommitMs'] = commit - tap
            result['rootRenderMs'] = next(r['actualDuration'] for r in rs if r.get('id') == 'Root' and r['t'] >= handler)
            reconciles = [r for r in rs if r['phase'] == 'reconcile' and handler <= r['t'] < commit]
            result['hiddenReconcileMs'] = sum(r['ms'] for r in reconciles if not r['visible'])
            result['visibleReconcileMs'] = sum(r['ms'] for r in reconciles if r['visible'])
    else:
        start = float(raw['meta']['launchBeforeUptime'].split()[0]) * 1000
        result['activityFirstDrawMs'] = int(re.search(r'TotalTime: (\d+)', raw['meta']['amStart']).group(1))
        by_phase = {phase: next((r['t'] for r in rs if r['phase'] == phase), None) for phase in [
            'root-module-evaluated', 'fonts-start', 'fonts-ready', 'splash-hide', 'room-list-commit', 'room-list-layout']}
        for key, phase in [('rootModuleMs', 'root-module-evaluated'), ('splashHideMs', 'splash-hide'), ('listCommitMs', 'room-list-commit')]:
            if by_phase[phase] is not None:
                result[key] = by_phase[phase] - start
        if by_phase['fonts-ready'] is not None and by_phase['fonts-start'] is not None:
            result['fontLoadMs'] = by_phase['fonts-ready'] - by_phase['fonts-start']
        if by_phase['room-list-commit'] is not None:
            draw = first_frame(fs, by_phase['room-list-commit'])
            result['listNativeFrameProxyMs'] = None if draw is None else draw - start
        taps = [r['ts'] for r in native if 'ACTION_UP' in r['name']]
        commits = [r['t'] for r in rs if r['phase'] == 'transcript-commit' and r.get('count', 0) > 0]
        if taps and commits:
            tap = taps[0]
            commit = next((t for t in commits if t >= tap), None)
            if commit is not None:
                draw = first_frame(fs, commit)
                result['roomDataCommitMs'] = commit - tap
                result['roomNativeFrameProxyMs'] = None if draw is None else draw - tap
    return {k: round(v, 3) if isinstance(v, float) else v for k, v in result.items()}


def analyze(records):
    samples = [summarize(raw) for raw in records]
    distributions = {}
    for arm, kind in sorted({(r['arm'], r['kind']) for r in samples}):
        rows = [r for r in samples if r['arm'] == arm and r['kind'] == kind]
        assert len(rows) == 5, (arm, kind, len(rows))
        group = {}
        for metric in sorted(set().union(*(r.keys() for r in rows)) - {'arm', 'kind', 'sample'}):
            values = [r[metric] for r in rows if isinstance(r.get(metric), (float, int))]
            group[metric] = {'n': len(values), 'median': round(statistics.median(values), 3), 'max': max(values)} if values else {'n': 0}
        distributions[arm + '/' + kind] = group
    return {'distributions': distributions, 'samples': samples}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--records', type=Path, default=ROOT / 'records.json.gz')
    parser.add_argument('--output', type=Path)
    args = parser.parse_args()
    records = json.loads(gzip.decompress(args.records.read_bytes()))
    encoded = json.dumps(analyze(records), indent=2) + '\n'
    if args.output:
        args.output.write_text(encoded)
    else:
        print(encoded, end='')
