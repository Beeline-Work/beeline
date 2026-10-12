#!/usr/bin/env python3
"""Pixel-measure the real web composer using chrome-devtools-axi.
Start the page with build-composer-hint-center-web.ts; see evidence README.
"""
import json, subprocess, time
from pathlib import Path
from PIL import Image
import os
os.environ['CHROME_DEVTOOLS_AXI_SESSION']='beeline-hint-center'
os.environ['CHROME_DEVTOOLS_AXI_PORT']='9238'
out=Path(__file__).resolve().parents[1]/'evidence/composer-hint-center/web'
out.mkdir(exist_ok=True)
def axi(*argv): return subprocess.check_output(['chrome-devtools-axi',*argv],text=True)
results=[]
for scale in [0.85,1.0,1.15,1.3]:
    for viewer in [False,True]:
        for content,value in [('empty',''),('typed','Message'),('tagged','@ruby Message')]:
            for focused in [False,True]:
                state={'value':value,'viewer':viewer,'scale':scale,'focused':focused}
                axi('eval','() => { hintProof.set('+json.dumps(state)+'); return true; }')
                time.sleep(.15)
                axi('eval','() => { window.dispatchEvent(new Event("resize")); const input=document.querySelector("textarea"); '+('input.focus(); input.setSelectionRange(input.value.length,input.value.length);' if focused else 'input.blur();')+' return true; }')
                time.sleep(.15)
                geom=axi('eval','() => { const input=document.querySelector("textarea"); const css=getComputedStyle(input); const row=input.parentElement.parentElement; const field=row.parentElement; const pill=document.querySelector("[data-testid=chat-tag-ruby]"); return {input:input.getBoundingClientRect().toJSON(),pill:pill?.getBoundingClientRect().toJSON(),top:field.getBoundingClientRect().top,bottom:field.getBoundingClientRect().bottom,lineHeight:parseFloat(css.lineHeight),transform:css.transform,font:css.font}; }')
                geometry=json.loads(json.loads(geom.split('result: ',1)[1].split('\nhelp',1)[0]))
                name=f'{scale:g}-'+('viewer' if viewer else 'room')+'-'+content+'-'+('focused' if focused else 'blurred')+'.png'
                axi('screenshot',str(out/name))
                im=Image.open(out/name).convert('RGB')
                ink_by_column={}
                for x in range(int(geometry['input']['left']),int(geometry['input']['right'])):
                    ys=[]
                    for y in range(int(geometry['top'])+4,int(geometry['bottom'])-4):
                        pill=geometry.get('pill')
                        if pill and pill['left']-1<=x<=pill['right']+1 and pill['top']-1<=y<=pill['bottom']+1:
                            continue
                        r,g,b=im.getpixel((x,y))
                        # Luminance keeps LCD/subpixel fringe pixels; color neutrality does not.
                        if .2126*r+.7152*g+.0722*b<180: ys.append(y)
                    # A caret is a narrow stroke taller than this word's cap/descender ink.
                    if ys and max(ys)-min(ys)+1 < geometry['lineHeight']-1:
                        ink_by_column[x]=ys
                counts={}
                for ys in ink_by_column.values():
                    for y in ys: counts[y]=counts.get(y,0)+1
                if not counts: raise RuntimeError(name+' no text ink')
                cap=min(counts)
                # Descender rows contain only g; the common baseline carries the other letters.
                baseline=max(y for y,n in counts.items() if n>=max(counts.values())/3)
                ink=[cap,baseline]
                center=(geometry['top']+geometry['bottom']-1)/2
                result=dict(state,frame=name,capTop=min(ink),baselineInkBottom=max(ink),fieldCenter=center,
                        bodyCenter=(min(ink)+max(ink))/2,offsetPx=(min(ink)+max(ink))/2-center,geometry=geometry,inkRowCounts=counts)
                results.append(result)
                (out/'measurements.json').write_text(json.dumps(results,indent=2)+'\n')
                print(name,result['offsetPx'],flush=True)
                if abs(result['offsetPx'])>1: raise SystemExit('FAIL')
print('PASS',len(results),'web pixel frames')
