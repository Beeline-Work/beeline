# Run under xvfb-run. Uses an isolated GTK/XSettings session and app data.
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time

base = Path('/tmp/jellybean-appearance')
config = base / 'xsettings.conf'
receipts = base / 'receipts.jsonl'
def theme(dark):
    config.write_text('Net/ThemeName "Adwaita' + ('-dark' if dark else '') + '"\nGtk/ApplicationPreferDarkTheme ' + ('1' if dark else '0') + '\n')

theme(False)
env = dict(os.environ)
for key, value in [('HOME', 'home'), ('XDG_CONFIG_HOME', 'config'), ('XDG_DATA_HOME', 'data'), ('XDG_CACHE_HOME', 'cache')]:
    target = base / value
    target.mkdir(exist_ok=True)
    env[key] = str(target)
xd = subprocess.Popen([str(base / 'extracted/usr/bin/xsettingsd'), '-c', str(config)], env=env)
server = subprocess.Popen([sys.executable, '-m', 'http.server', '8081', '--bind', '127.0.0.1', '--directory', str(base / 'site')], env=env)
app = None
try:
    time.sleep(1)
    receipts.write_text('')
    app = subprocess.Popen([sys.argv[1]], env=env)
    def wait_for(scheme):
        for _ in range(80):
            rows = [json.loads(line) for line in receipts.read_text().splitlines()]
            if rows and rows[-1]['system'] == scheme:
                return rows[-1]
            time.sleep(.25)
        raise AssertionError(f'missing {scheme}: {rows}')
    results = [wait_for('light')]
    theme(True)
    xd.send_signal(signal.SIGHUP)
    results.append(wait_for('dark'))
    theme(False)
    xd.send_signal(signal.SIGHUP)
    results.append(wait_for('light'))
    assert [r['theme'] for r in results] == ['bone', 'obsidian', 'bone'], results
    assert [r['darkMedia'] for r in results] == [False, True, False], results
    (base / 'desktop-results.json').write_text(json.dumps(results, indent=2))
    print(json.dumps(results, indent=2))
finally:
    for child in [app, server, xd]:
        if child is not None:
            child.terminate()
            child.wait(timeout=10)
