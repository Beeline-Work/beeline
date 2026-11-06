"""Compare the same production-row scene before and after the title correction."""
import json
import re
import subprocess
from pathlib import Path
from xml.etree import ElementTree as ET

root = Path('apps/mobile/evidence/title-alignment')
receipts = []

def bounds(node):
    return tuple(map(int, re.findall(r'\d+', node.get('bounds'))))

def nodes(phase, theme):
    return list(ET.parse(root / f'android-{phase}-{theme}.xml').iter('node'))

def pixels(phase, theme):
    return subprocess.check_output(['ffmpeg', '-v', 'error', '-i',
        str(root / f'android-{phase}-{theme}.png'), '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'])

for theme in ['bone', 'obsidian']:
    before, after = nodes('before', theme), nodes('after', theme)
    old_pixels, new_pixels = pixels('before', theme), pixels('after', theme)
    assert len(old_pixels) == len(new_pixels) == 1080 * 2400 * 3
    for index, title in enumerate(['corner-glyph-alignment', 'mock-embedded-fonts',
        'a-long-corner-name-that-must-truncate-without-moving-either-icon']):
        old_row = next(n for n in before if n.get('content-desc') == 'Open corner ' + title)
        new_row = next(n for n in after if n.get('content-desc') == 'Open corner ' + title)
        assert bounds(old_row) == bounds(new_row)
        row = bounds(new_row)
        old_text = bounds(next(n for n in before if n.get('text') == 'Opened ' + title))
        new_text = bounds(next(n for n in after if n.get('text') == 'Opened ' + title))
        center = (row[1] + row[3]) / 2
        old_offset = (old_text[1] + old_text[3]) / 2 - center
        new_offset = (new_text[1] + new_text[3]) / 2 - center
        assert old_offset <= -5
        assert abs(new_offset) <= 1
        assert old_text[0::2] == new_text[0::2]
        # The two icon columns contain no text. Their rendered pixels stay fixed.
        for left, right in [(42, 85), (995, 1038)]:
            for y in range(row[1], row[3]):
                start, end = (y * 1080 + left) * 3, (y * 1080 + right) * 3
                assert old_pixels[start:end] == new_pixels[start:end]
        receipts.append({'theme': theme, 'title': title, 'rowBounds': row,
            'beforeTextCenterOffsetPx': old_offset, 'afterTextCenterOffsetPx': new_offset,
            'iconPixelsUnchanged': True})
(root / 'android-geometry.json').write_text(json.dumps(receipts, indent=2) + '\n')
print('PASS: title-alignment-01 on native Android in both themes; title centered, icon pixels and touch bounds unchanged.')
