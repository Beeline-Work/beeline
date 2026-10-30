"""Substitute a JS export into a downloaded store APK for local proof only."""
import glob
import re
import sys
import zipfile

original, export_dir, output = sys.argv[1:]
bundles = glob.glob(export_dir + '/_expo/static/js/android/*.hbc')
if len(bundles) != 1:
    raise ValueError('Expected exactly one exported Android Hermes bundle')
with zipfile.ZipFile(original) as source, zipfile.ZipFile(output, 'w') as target:
    for item in source.infolist():
        # Preserve META-INF/services and Kotlin metadata; remove signature files.
        if re.match(r'META-INF/[^/]+\.(RSA|SF|MF|DSA|EC)$', item.filename, re.I):
            continue
        data = open(bundles[0], 'rb').read() if item.filename == 'assets/index.android.bundle' else source.read(item.filename)
        target.writestr(item, data)
