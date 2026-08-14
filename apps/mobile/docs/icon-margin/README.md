# App icon margin verification

These API 36 (`emulator-5554`) launcher captures compare the production app
before and after the icon mark inset changed. Both images are unscaled crops
from the same Pixel launcher slot.

The mark's 146-unit height on its 240-unit source canvas left an average
47-unit vertical margin. The generator now renders icon marks at 83.260274%
of their prior linear size, producing a 121.56-unit mark and a 59.22-unit
average vertical margin: exactly 1.26 times the previous margin.

- `launcher-before.png`: current `main`, production versionCode 16.
- `launcher-after.png`: this change, production versionCode 17.

## Surface scoping

The 26%-larger margin is a launcher treatment, not a logo treatment. The
launcher source and Android adaptive/monochrome foregrounds retain it. Web
favicon and Android splash sources render the untransformed continuous-line
mark on their surface background; the Android notification icon renders the
same untransformed mark transparently.

The comparison boards use the exact generated source assets. Their left tiles
represent the previously shared launcher-inset source, and their right tiles
represent the corrected surface output:

- `launcher-scope-before-after.png`: launcher inset is unchanged.
- `splash-scope-before-after.png`: splash no longer inherits the launcher inset.
- `favicon-scope-before-after.png`: favicon no longer inherits the launcher inset.
