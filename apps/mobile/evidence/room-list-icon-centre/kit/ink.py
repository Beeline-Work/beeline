"""Measure ink edges and centres (CSS px, DPR 2) from capture.mjs screenshots and DOM rects."""
import json, sys
from collections import Counter
from PIL import Image
D = 2; T = 60
def ink(im, rect, pad=0, trim=0, T=T):
    l, t, r, b = (rect['l'] - pad) * D, (rect['t'] + trim) * D, (rect['r'] + pad) * D, (rect['b'] - trim) * D
    # Measure from the crop's whole-pixel origin, not the fractional box edge.
    l = int(l)
    crop = im.crop((l, int(t), int(r), int(b))).convert('RGB')
    w, h = crop.size; px = crop.load()
    bg = Counter(crop.getdata()).most_common(1)[0][0]
    xs = [x for x in range(w) for y in range(h) if sum(abs(a - c) for a, c in zip(px[x, y], bg)) > T]
    return (l + min(xs)) / D, (l + max(xs) + 1) / D
def measure(side):
    rects = json.load(open(f'/tmp/rlic/shots/{side}/rects.json'))
    report = {}
    for key, s in rects.items():
        im = Image.open(f'/tmp/rlic/shots/{side}/{key}.png')
        desk = key.startswith('desktop')
        L = s['pane']['l'] if desk else 0
        R = max(x['row']['r'] for x in s['rows']) if desk else s['viewport']['w']
        m = {}
        m['header avatar left'] = ink(im, s['trigger'])[0] - L
        def edge(name, rect):
            l, r = ink(im, rect)
            m[f'{name} right'] = R - r
            m[f'{name} centre'] = R - (l + r) / 2
        edge('header tray', s['tray'])
        m['filter All left'] = ink(im, s['filterAll'])[0] - L
        edge('search', s['search'])
        for i, h in enumerate(s['heads']):
            m[f'section {i} label left'] = ink(im, h['label'])[0] - L
            edge(f'section {i} +', h['plus'])
        for i, row in enumerate(s['rows']):
            if desk:
                m[f'row {i} name left'] = ink(im, row['name'])[0] - L
                inner = dict(row['row']); inner['r'] -= 0; inner['l'] += 2
                m[f'row {i} right content right'] = R - ink(im, inner, trim=3)[1]
            else:
                f = row['frame']
                m[f'card {i} left'] = ink(im, {'l': f['l'] - 3, 't': f['t'] + 20, 'r': f['l'] + 1, 'b': f['b'] - 20}, T=12)[0] - L
                m[f'card {i} right'] = R - ink(im, {'l': f['r'] - 1, 't': f['t'] + 20, 'r': f['r'] + 3, 'b': f['b'] - 20}, T=12)[1]
        report[key] = {k: round(v, 2) for k, v in m.items()}
    return report
if __name__ == '__main__':
    out = {side: measure(side) for side in sys.argv[1:]}
    json.dump(out, open('/tmp/rlic/shots/ink.json', 'w'), indent=1)
    for side, rep in out.items():
        for key, m in rep.items():
            print(side, key, json.dumps(m))
