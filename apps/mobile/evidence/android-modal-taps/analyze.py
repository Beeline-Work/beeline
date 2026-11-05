"""Recompute Room sheet timings from sanitized Perfetto and HWUI records."""
import argparse
import gzip
import json
import re
import statistics
from pathlib import Path

ROOT = Path(__file__).resolve().parent


def marks(log):
    rows = []
    for line in log.splitlines():
        if '[PHONE_TAPS] ' in line:
            rows.extend(json.loads(line.split('[PHONE_TAPS] ', 1)[1]))
    return rows


def frames(source):
    header = None
    rows = []
    for line in source.splitlines():
        if line.startswith('Flags,'):
            header = line.rstrip(',').split(',')
        elif header and re.match(r'^\d+,', line):
            row = dict(zip(header, map(int, line.rstrip(',').split(','))))
            # Android15: bit0 WindowVisibilityChanged is valid on first draw;
            # bit3 SkippedFrame and incomplete/misordered frames are invalid.
            if not row['Flags'] & 8 and 0 < row['DrawStart'] <= row['FrameCompleted'] < 10**18:
                rows.append(row)
    return rows


def first_frame(rows, after):
    return min((r['FrameCompleted'] / 1e6 for r in rows if r['DrawStart'] / 1e6 >= after), default=None)


def analyze(records):
    samples = []
    for raw in records:
        tap = next(r['ts'] for r in raw['nativeSlices'] if 'ACTION_UP' in r['name'])
        rs = [r for r in marks(raw['log']) if r['t'] >= tap]
        commit = next(r['t'] for r in rs if r['phase'] == 'sheet-commit')
        layout = next(r['t'] for r in rs if r['phase'] == 'sheet-native-layout')
        handler = next(r['t'] for r in rs if r['phase'] == 'sheet-tap')
        window = next((r['ts'] for r in raw['nativeSlices'] if 'relayoutWindow#first=true' in r['name']), commit)
        fs = frames(raw['gfx'])
        draw = first_frame(fs, max(window, commit))
        conservative = first_frame(fs, max(window, commit, layout))
        assert draw is not None and conservative is not None
        row = {
            'arm': raw['arm'], 'sample': raw['sample'],
            'handlerMs': handler - tap,
            'contentCommitMs': commit - tap,
            'nativeLayoutCallbackMs': layout - tap,
            'nativeFrameProxyMs': draw - tap,
            'callbackGatedFrameProxyMs': conservative - tap,
            'rootRenderMs': next(r['actualDuration'] for r in rs if r.get('id') == 'Root' and r['t'] >= handler),
        }
        samples.append({k: round(v, 3) if isinstance(v, float) else v for k, v in row.items()})
    distributions = {}
    for arm in sorted({r['arm'] for r in samples}):
        rows = [r for r in samples if r['arm'] == arm]
        assert len(rows) == 5, (arm, len(rows))
        distributions[arm] = {
            metric: {'n': 5, 'median': round(statistics.median(r[metric] for r in rows), 3), 'max': max(r[metric] for r in rows)}
            for metric in rows[0] if metric not in ['arm', 'sample']
        }
    return {'distributions': distributions, 'samples': samples}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--records', type=Path, default=ROOT / 'records.json.gz')
    parser.add_argument('--output', type=Path)
    args = parser.parse_args()
    encoded = json.dumps(analyze(json.loads(gzip.decompress(args.records.read_bytes()))), indent=2) + '\n'
    if args.output:
        args.output.write_text(encoded)
    else:
        print(encoded, end='')
