"""Build the inert, self-contained audit from the committed evidence manifest."""
import base64
import html
import json
from pathlib import Path
import sys
root = Path(__file__).resolve().parents[2] / 'evidence/ui-repair-audit'
output = Path(sys.argv[1]) if len(sys.argv) > 1 else root / 'audit.html'
rows = json.loads((root / 'manifest.json').read_text())
def picture(path):
    if not path.exists():
        raise FileNotFoundError(path)
    mime = 'image/jpeg' if path.suffix == '.jpg' else 'image/png'
    return '<img alt="Rendered UI evidence" src="data:' + mime + ';base64,' + base64.b64encode(path.read_bytes()).decode() + '">'
css = '''body{font:15px/1.5 system-ui;background:#F3EEE4;color:#171310;margin:24px}main{max-width:1300px;margin:auto}h1{font-size:26px}h2{font-size:19px}section{border-top:1px solid #C9BBA0;padding:20px 0}.frames{display:flex;gap:16px;overflow:auto}figure{margin:0;width:390px;flex-shrink:0}img{display:block;width:100%;height:auto}.broken{color:#943b31}.fine{color:#466332}code{font-size:12px;overflow-wrap:anywhere}table{border-collapse:collapse;width:100%}td,th{text-align:left;padding:8px;border-bottom:1px solid #DED2BC}figcaption{font-weight:600;margin-bottom:8px}'''
s = '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Beeline UI audit</title><style>' + css + '</style></head><body><main>'
s += '<h1>UI sweep audit — parent, main, fixed</h1><p>The complete inventory of changed UI call sites, with the original finding marked broken or fine and the fixed result beside it.</p>'
s += '<p>Fresh web captures render production controls and fonts at phone width (390 px), with device and API stubs. Parent is the label-sweep parent; the usage section is identical there and at its own PR parent. Main is f25b955b6. The browser HTTP proxy and swipe proof use their exact PR parents. Desktop-only headers are stress-tested at phone width. Isolated caller compositions and historical native evidence are identified in each finding.</p>'
s += '<p>Fresh Android evidence uses a locally built release-mode APK with current-main native configuration, production CommunityRail and RepoPicker, and parent versions of those two controls in the same native fixture. Device: Android 15 (API 35), three-button navigation, physical screen (1080 × 2400), density (420). The SDK documents that Android 15 emulators can ignore navigation-button style changes; the paired system/app-theme captures verify contrast and matching backgrounds.</p>'
s += '<p>The browser header alignment was already imperfect in the parent. The longer label made it conspicuous; it is fixed here as requested. Squire must signal host-ended when its login window closes. Beeline does not inspect remote pixels or change typing.</p>'
if len(sys.argv) > 2:
    owners = Path(sys.argv[2])
    s += '<section><h2>Owner screenshots</h2><p>Original evidence retained from the earlier handoff artifact.</p><div class="frames">'
    for name in ['owner-3.jpg', 'owner-1.jpg']:
        s += '<figure>' + picture(owners / name) + '</figure>'
    s += '</div></section>'
s += '<table><tr><th>Call site</th><th>Main finding</th><th>Result</th></tr>'
for row in rows:
    s += '<tr><td>' + html.escape(row['name']) + '</td><td>' + html.escape(row['note']) + '</td><td class="' + row['status'] + '">' + row['status'].upper() + '</td></tr>'
s += '</table>'
for row in rows:
    s += '<section><h2 class="' + row['status'] + '">' + html.escape(row['name']) + ' — ' + row['status'].upper() + '</h2><code>PR (' + row['pr'] + ') · ' + html.escape(row['file']) + '</code><p>' + html.escape(row['note']) + '</p>'
    if row.get('fixedNote'):
        s += '<p><b>Fixed result:</b> ' + html.escape(row['fixedNote']) + '</p>'
    s += '<div class="frames">'
    for label, filename in row['captures']:
        s += '<figure><figcaption>' + html.escape(label) + '</figcaption>' + picture(root / filename) + '</figure>'
    s += '</div></section>'
s += '</main></body></html>'
output.parent.mkdir(parents=True, exist_ok=True)
output.write_text(s)
print(str(output), len(rows), 'call sites', len(s), 'bytes')
