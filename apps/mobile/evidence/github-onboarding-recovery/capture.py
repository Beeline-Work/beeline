"""Capture deterministic native component states on the leased Android stand-in."""
import subprocess,time
from pathlib import Path
out=Path('.verification/onboarding/after-android');out.mkdir(parents=True,exist_ok=True)
def adb(*args):return subprocess.check_output(['adb','-s','emulator-5554',*args])
for theme in ['bone','obsidian']:
 for state in ['cancel','expired','offline','ownership','return','github','picker']:
  adb('shell',f'am start -a android.intent.action.VIEW -d "beeline://onboarding-proof?state={state}&theme={theme}" -p app.usebeeline')
  time.sleep(1)
  (out/f'{state}-{theme}.png').write_bytes(adb('exec-out','screencap','-p'))
  print(f'{state}-{theme}',flush=True)
