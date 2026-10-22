"""Build the baseline controls, preserving the final sources even on build failure."""
import subprocess, json, shutil
from pathlib import Path
root=Path.cwd()
mobile=root/'apps/mobile'
files=['sources/components/buzz/'+name+'.tsx' for name in ['Button','MembersAgentsGlyph','RoomListSectionHeader','RoomListToolbar','TrayGlyph']]+['sources/buzz/groknight.ts']
final={name:(mobile/name).read_text() for name in files}
out=root/'.verification/header-alignment'
out.mkdir(parents=True,exist_ok=True)
(out/'restore-final-sources.json').write_text(json.dumps(final))
apk=mobile/'android/app/build/outputs/apk/release/app-release.apk'
shutil.copyfile(apk,out/'after.apk')
try:
    for name in files:
        (mobile/name).write_bytes(subprocess.check_output(['git','show','b82f0f7fb:apps/mobile/'+name]))
    with (out/'android-before-build.log').open('w') as log:
        subprocess.run([str(mobile/'android/gradlew'),'-p',str(mobile/'android'),'assembleRelease','-PreactNativeArchitectures=x86_64','--no-daemon','--max-workers=2','--console=plain'],stdout=log,stderr=subprocess.STDOUT,check=True)
    shutil.copyfile(apk,out/'before.apk')
finally:
    for name,source in final.items(): (mobile/name).write_text(source)
print('Baseline APK built; final sources restored.')
