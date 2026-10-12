"""Audit the native PNGs; requires Pillow. All bounds are physical pixels.

Native measureInWindow gives the composer's top at 777.5238dp closed and
465.1429dp with the keyboard open. At 420dpi (2.625px/dp), plus Android's
136px window/status-bar offset, these are y=2177 and y=1357. The band's
42dp coverage is 110.25px; use the first wholly covered physical pixel.
"""
import json
from pathlib import Path
from PIL import Image

EVIDENCE = Path(__file__).resolve().parents[1] / 'evidence/status-band-coverage'
CANVASES = {'bone': (243, 238, 228), 'obsidian': (20, 9, 26)}
results = []
for path in sorted(EVIDENCE.glob('android-*.png')):
    theme = 'bone' if 'bone' in path.name else 'obsidian'
    canvas = CANVASES[theme]
    image = Image.open(path).convert('RGB')
    keyboard = 'keyboard' in path.name
    composer_top = 1357 if keyboard else 2177
    band_top = composer_top - 110
    pending = 'after-pending' in path.name
    def off_canvas(top, bottom):
        return sum(pixel != canvas for pixel in image.crop((0, top, 1080, bottom)).getdata())
    upper_air = None if pending else off_canvas(band_top, band_top + 23)
    join = off_canvas(composer_top, composer_top + 21)
    transcript_ink = None
    if not pending:
        # The monochrome settled Beeline glyph legitimately uses dark ink in
        # Bone; exclude its fixed cell. Status labels use brass in both themes.
        pixels = image.crop((64, band_top, 1080, composer_top + 21)).getdata()
        if theme == 'bone':
            transcript_ink = sum(r < 180 and abs(r-g) < 10 and abs(g-b) < 13 for r, g, b in pixels)
        else:
            transcript_ink = sum(r > 200 and g > 200 and b > 200 for r, g, b in pixels)
    result = {'frame': path.name, 'composerTopPx': composer_top,
              'upperAirOffCanvasPixels': upper_air, 'composerJoinOffCanvasPixels': join,
              'transcriptInkPixelsOutsideGlyph': transcript_ink}
    results.append(result)
    if 'after-' in path.name:
        assert join == 0, result
        if not pending:
            assert upper_air == 0 and transcript_ink == 0, result
print(json.dumps({'screenPx': [1080, 2400], 'density': 2.625,
                  'windowOffsetPx': 136, 'bandDp': 42, 'results': results}, indent=2))
