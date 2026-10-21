import json
from pathlib import Path

rows = []
for entry in Path('/proc').iterdir():
    if not entry.name.isdigit():
        continue
    try:
        command = (entry / 'cmdline').read_bytes().replace(b'\0', b' ')
        if b'beeline' not in command or not any(marker in command for marker in [b' daemon', b'--machine', b'machine-helper']):
            continue
        if b'.jellybean-helper-env-names.py' in command:
            continue
        names = sorted(part.split(b'=', 1)[0].decode('ascii', errors='replace')
                       for part in (entry / 'environ').read_bytes().split(b'\0') if b'=' in part)
        rows.append({'pid': int(entry.name), 'names': [name for name in names
                     if name.startswith(('BUZZY_', 'BEELINE_'))]})
    except (PermissionError, FileNotFoundError, ProcessLookupError):
        continue
print(json.dumps({'helperProcesses': rows}))
