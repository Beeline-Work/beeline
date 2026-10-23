"""Before/after crops of the Room list's right edge, zoomed, with the 20 pt edge
(grey) and the search ink centre (red) drawn on. One PNG per surface and theme."""
import json, sys
from PIL import Image, ImageDraw
D = 2; Z = 3; W = 90  # CSS px kept from the right edge, zoom
src, dst = sys.argv[1], sys.argv[2]
ink = json.load(open(f'{src}/ink.json'))
for key in ['phone-bone', 'phone-obsidian', 'desktop-bone', 'desktop-obsidian']:
    panels = []
    for side in ['before', 'after']:
        s = json.load(open(f'{src}/{side}/rects.json'))[key]
        desk = key.startswith('desktop')
        R = max(x['row']['r'] for x in s['rows']) if desk else s['viewport']['w']
        bottom = s['heads'][-1]['row']['b'] + 4
        im = Image.open(f'{src}/{side}/{key}.png').convert('RGB')
        crop = im.crop((int((R - W) * D), 0, int(R * D), int(bottom * D)))
        crop = crop.resize((int(W * Z), int(bottom * Z)), Image.NEAREST)
        dr = ImageDraw.Draw(crop)
        x = lambda fromRight: (W - fromRight) * Z
        dr.line([(x(20), 0), (x(20), crop.height)], fill=(150, 150, 150), width=1)
        c = ink[side][key]['search centre']
        dr.line([(x(c), 0), (x(c), crop.height)], fill=(220, 40, 40), width=1)
        label = Image.new('RGB', (crop.width, 28), (255, 255, 255))
        m = ink[side][key]
        ImageDraw.Draw(label).text((4, 8), f"{side}: tray {m['header tray centre']}  search {m['search centre']}  + {m['section 0 + centre']}", fill=(0, 0, 0))
        panel = Image.new('RGB', (crop.width, crop.height + 28), (255, 255, 255))
        panel.paste(label, (0, 0)); panel.paste(crop, (0, 28))
        panels.append(panel)
    out = Image.new('RGB', (sum(p.width for p in panels) + 12, max(p.height for p in panels)), (255, 255, 255))
    out.paste(panels[0], (0, 0)); out.paste(panels[1], (panels[0].width + 12, 0))
    out.save(f'{dst}/{key}.png')
