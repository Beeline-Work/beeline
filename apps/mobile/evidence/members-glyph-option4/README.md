# Members glyph option 4: two heads only

Owner selection relayed by Ruby from message f86ce387. Implements the supplied 24 × 24 geometry as react-native-svg: rear person circle; front rounded agent head, antenna and eyes; no shoulders or body. The rear circle is masked using the agent silhouette expanded by 1.1 viewBox units. Mask luminance values control transparency, not the theme background. Visible strokes use chromeStrokeWidth and the header ledgerQuiet colour, matching the replaced overflow icon.

## Native captures

Unedited full Android API 36 app screenshots, signed into the isolated test workspace documented in ../members-settings-prototype/README.md.

- 01-header-bone.png: actual 22px header glyph in Bone.
- 02-enlarged-bone.png: same 22px component magnified 8× by a temporary native inspection overlay.
- 03-header-obsidian.png: actual header glyph in Obsidian.
- 04-enlarged-obsidian.png: same temporary 8× inspection overlay in Obsidian.

The enlarged views intentionally magnify the native 22px render, including its rasterization; they are not replacement artwork. The inspection overlay was removed before validation and commit. The glyph itself has no background fill. Both masks remain transparent against their theme surfaces. Tapping the header mark still opens the existing Members page.

All revision 3 navigation remains as previously delivered. These captures supersede the placeholder glyph in ../members-settings-revision3. No merge or release.
