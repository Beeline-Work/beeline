from pathlib import Path
import subprocess,time,sys,urllib.request,os
root=Path(__file__).resolve().parents[3];os.chdir(root)
serial=os.environ.get('ANDROID_SERIAL','emulator-5554')
if not serial.startswith('emulator-'): raise SystemExit('Use the isolated leased emulator')
out=root/'apps/mobile/docs/evidence/section-surfaces'/sys.argv[1];out.mkdir(parents=True,exist_ok=True)
for _ in range(50):
 try: urllib.request.urlopen('http://127.0.0.1:8100',timeout=1);break
 except Exception:time.sleep(1)
for theme in ['bone','obsidian']:
 for surface in (sys.argv[2:] or ['sheet','page','repos','workbench','service']):
  (root/'apps/mobile/surface-proof/settings.ts').write_text(f"export const proofTheme: 'bone' | 'obsidian' = '{theme}';\nexport const proofSurface: string = '{surface}';\n")
  time.sleep(1)
  subprocess.run(['adb','-s',serial,'shell','pm','clear','host.exp.exponent'],stdout=subprocess.DEVNULL)
  subprocess.run(['adb','-s',serial,'shell','am','start','-a','android.intent.action.VIEW','-d','exp://127.0.0.1:8100','-p','host.exp.exponent'],stdout=subprocess.DEVNULL)
  time.sleep(4)
  subprocess.run(['adb','-s',serial,'shell','input','tap','540','2200'],stdout=subprocess.DEVNULL)
  time.sleep(.4)
  subprocess.run(['adb','-s',serial,'shell','input','keyevent','4'],stdout=subprocess.DEVNULL)
  time.sleep(.6)
  if surface == 'sheet':
   subprocess.run(['adb','-s',serial,'shell','input','tap','200','240'],stdout=subprocess.DEVNULL)
   time.sleep(.6)
  (out/f'phone-{theme}-{surface}.png').write_bytes(subprocess.check_output(['adb','-s',serial,'exec-out','screencap','-p']))
  print(theme,surface,flush=True)
