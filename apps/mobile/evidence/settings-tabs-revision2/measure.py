"""Pixel analysis of the ROOMS section header (Android, 412x915 @160dpi, so 1 px = 1 dp).
Divider: the full-width 1 px rule under the filter row (row whose pixels across x=0..411 all differ
from the background). Label: bounding box of non-background pixels in the ROOMS label column x=16..90.
Card top: first row below the label where the card border/fill spans x=17..395."""
import sys, json
from PIL import Image
def measure(path):
    im = Image.open(path).convert('RGB'); W, H = im.size; px = im.load()
    bg = px[5, 180]
    diff = lambda a, b: sum(abs(x - y) for x, y in zip(a, b))
    # divider: below y=140, a row where >95% of columns differ from bg
    is_rule = lambda y: sum(diff(px[x, y], bg) > 12 for x in range(W)) > 0.95 * W
    divider = next(y for y in range(140, 190) if is_rule(y))
    while is_rule(divider + 1): divider += 1  # the rule is 2 px thick; use its last row
    ink = [y for y in range(divider + 2, 240) if any(diff(px[x, y], bg) > 60 for x in range(16, 90))]
    # first contiguous run of ink rows = the label
    label_top = ink[0]; label_bottom = label_top
    while label_bottom + 1 in ink: label_bottom += 1
    card_top = next(y for y in range(label_bottom + 1, 260) if sum(diff(px[x, y], bg) > 12 for x in range(40, 350)) > 0.9 * 310)
    return dict(divider_last_row_y=divider, label_glyph_top_y=label_top, label_glyph_bottom_y=label_bottom, card_top_y=card_top,
                divider_to_label_top_px=label_top - divider - 1, label_bottom_to_card_top_px=card_top - label_bottom - 1)
print(json.dumps({p: measure(p) for p in sys.argv[1:]}, indent=1))
