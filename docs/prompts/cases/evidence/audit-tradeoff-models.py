import json
import pathlib
import sys

root = pathlib.Path(sys.argv[1])
cases = {p.stem for p in pathlib.Path(__file__).resolve().parent.parent.glob('*.json')}
checked = 0
missing_metadata = []
unexpected = []
for variant in ('with', 'without'):
    for path in sorted((root / variant).glob('*.raw')):
        case_id = path.stem.rsplit('.', 1)[0]
        if case_id not in cases:
            continue
        models = set()
        for entry in json.loads(path.read_text()):
            try:
                envelope = json.loads(entry.get('stdout', ''))
            except (ValueError, TypeError):
                continue
            models.update(envelope.get('modelUsage', {}))
        checked += 1
        if models - {'claude-opus-5-5'}:
            unexpected.append(str(path))
        if not models:
            missing_metadata.append(str(path))
            try:
                json.loads(path.with_suffix('.json').read_text())
            except ValueError:
                continue
            unexpected.append(str(path) + ': a parsed answer has no model metadata')
print(json.dumps({'checked': checked, 'unexpected': unexpected,
                  'missing_metadata_failed_attempts': missing_metadata}, indent=2))
raise SystemExit(bool(unexpected))
