#!/usr/bin/env python3
"""Pixel proof against the standalone real native composer (never emulator-5554).
Run after building composer-hint-center-native.tsx as the release entry.
"""
import argparse, json, re, subprocess, time
from pathlib import Path
import xml.etree.ElementTree as ET
from PIL import Image

parser = argparse.ArgumentParser()
parser.add_argument('--device', required=True)
parser.add_argument('--out', type=Path, required=True)
parser.add_argument('--quick', action='store_true')
args = parser.parse_args()
if args.device == 'emulator-5554':
    raise SystemExit('Refusing shared emulator-5554')
args.out.mkdir(parents=True, exist_ok=True)
results = []
control_bounds = {}
input_horizontal_bounds = (0, 0)
last_field_center = 0
def adb(*cmd, binary=False):
    return subprocess.check_output(['adb', '-s', args.device, *cmd], text=not binary)
def nodes():
    adb('shell', 'uiautomator', 'dump', '/sdcard/hint-proof.xml')
    return ET.fromstring(adb('exec-out', 'cat', '/sdcard/hint-proof.xml')).iter('node')
def bounds(node):
    return list(map(int, re.findall(r'\d+', node.attrib['bounds'])))
def tap(label):
    if label == 'Message':
        x1,x2 = input_horizontal_bounds
        x,y = (x1+x2)//2, int(last_field_center)
    else:
        x1,y1,x2,y2 = control_bounds[label]
        x,y = (x1+x2)//2,(y1+y2)//2
    adb('shell', 'input', 'tap', str(x), str(y))
    time.sleep(0.25)
def frame(path):
    global last_field_center
    time.sleep(0.65)
    path.write_bytes(adb('exec-out', 'screencap', '-p', binary=True))
    im = Image.open(path).convert('RGB')
    w, h = im.size
    border = []
    for y in range(h//3, h):
        count = 0
        for x in range(w//2-75, w//2+75):
            r,g,b = im.getpixel((x,y))
            count += r>90 and r>g*1.2 and g>b*1.5 and b<90
        if count>35: border.append(y)
    if not border: raise RuntimeError('No field border in '+str(path))
    top,bottom = min(border), max(border)
    left,right = input_horizontal_bounds
    last_field_center = (top+bottom)/2
    # Neutral body ink excludes the colored tag and cursor. First letter is M.
    pixels = []
    for x in range(left, right):
        ys = []
        for y in range(top+6, bottom-6):
            r,g,b = im.getpixel((x,y))
            if r<180 and r>=g>=b and r-b<45:
                ys.append(y)
        if len(ys)>=2: pixels.append((x, ys))
    if not pixels: raise RuntimeError('No body ink in '+str(path))
    first = pixels[0][0]
    columns = []
    previous = first-1
    for x,ys in pixels:
        if x-previous>2: break
        columns += ys
        previous = x
    cap,baseline = min(columns),max(columns)
    center=(top+bottom)/2
    return {'fieldTop':top,'fieldBottom':bottom,'fieldCenter':center,
            'capTop':cap,'baselineInkBottom':baseline,
            'bodyCenter':(cap+baseline)/2,'offsetPx':(cap+baseline)/2-center,
            'inputHorizontalBounds':[left,right],'frame':path.name}

for dpi in ([420] if args.quick else [420,450,560]):
  for scale in ([1.0] if args.quick else [0.85,1.0,1.15,1.3]):
    adb('shell','wm','density',str(dpi))
    adb('shell','settings','put','system','font_scale',str(scale))
    adb('shell','am','force-stop','app.usebeeline')
    adb('shell','am','start','-n','app.usebeeline/.MainActivity')
    time.sleep(2)
    discovered = list(nodes())
    control_bounds = {n.attrib['content-desc']: bounds(n) for n in discovered if n.attrib.get('content-desc')}
    field_bounds = bounds(next(n for n in discovered if n.attrib.get('class') == 'android.widget.EditText'))
    input_horizontal_bounds = (field_bounds[0],field_bounds[2])
    last_field_center = (field_bounds[1]+field_bounds[3])/2
    for surface in ['Room','Viewer']:
      tap(surface)
      for content in ['Empty','Typed','Tagged']:
        tap(content)
        for keyboard in ['closed','open']:
          if keyboard=='closed': tap('Hide keyboard')
          else: tap('Message')
          name=f'{dpi}-{scale:g}-{surface.lower()}-{content.lower()}-{keyboard}.png'
          measured=frame(args.out/name)
          measured.update(dpi=dpi,fontScale=scale,surface=surface,content=content,keyboard=keyboard)
          results.append(measured)
          print(name, 'offset', measured['offsetPx'], flush=True)
          (args.out/'measurements.json').write_text(json.dumps(results,indent=2)+'\n')
          if abs(measured['offsetPx'])>1:
            raise SystemExit('FAIL: body more than 1 physical pixel from center')
print(f'PASS {len(results)} pixel-measured frames')
