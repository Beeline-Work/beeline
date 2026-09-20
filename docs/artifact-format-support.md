# Artifact format support

This inventory covers artifacts posted by `post_artifact`, not ordinary chat
attachments. The upload limit is 25 MB. A supplied MIME type is authoritative;
the extension is used only to infer a MIME when posting by path.

`Inline` means the transcript card paints the artifact itself or the app has a
full viewer for it. `External` means the card remains a file row and the signed
browser/system handoff is the only way to see the contents on that surface.

| MIME type                  | Inferred extensions                   | iOS preview | iOS viewer | Android preview | Android viewer | Desktop preview | Desktop work pane |
| -------------------------- | ------------------------------------- | ----------- | ---------- | --------------- | -------------- | --------------- | ----------------- |
| `text/html`                | `.html`, `.htm`                       | Inline      | Inline     | Inline          | Inline         | Inline          | Inline            |
| `image/svg+xml`            | `.svg`                                | Inline      | Inline     | Inline          | Inline         | Inline          | Inline            |
| `application/pdf`          | `.pdf`                                | Inline      | Inline     | External        | External       | External        | External          |
| `text/markdown`            | `.md`                                 | Inline      | Inline     | Inline          | Inline         | Inline          | Inline            |
| `image/png`                | `.png`                                | External    | Inline     | External        | Inline         | External        | External          |
| `image/jpeg`               | `.jpg`, `.jpeg`                       | External    | Inline     | External        | Inline         | External        | External          |
| `image/gif`                | `.gif`                                | External    | Inline     | External        | Inline         | External        | External          |
| `image/webp`               | `.webp`                               | External    | Inline     | External        | Inline         | External        | External          |
| `text/plain`               | `.txt`, `.log`                        | External    | External   | External        | External       | External        | External          |
| `application/json`         | `.json`                               | External    | External   | External        | External       | External        | External          |
| `text/csv`                 | `.csv`                                | External    | External   | External        | External       | External        | External          |
| `application/zip`          | `.zip`                                | External    | External   | External        | External       | External        | External          |
| `application/octet-stream` | Any unrecognized or missing extension | External    | External   | External        | External       | External        | External          |

## Unsupported combinations

All accepted artifacts retain an `Open in browser` path. The unsupported
inline combinations are:

- PDF preview and in-app viewing on Android. `Open` hands off through a signed
  URL and closes the modal.
- PDF preview and work-pane viewing on desktop.
- PNG, JPEG, GIF, and WebP previews on iOS and Android. Their full-size native
  viewer is supported.
- PNG, JPEG, GIF, and WebP previews and work-pane viewing on desktop.
- Plain text, JSON, CSV, ZIP, and octet-stream preview and in-app/work-pane
  viewing on every surface.

Upload combinations outside the table are also unsupported when the caller
supplies their MIME explicitly: `post_artifact` rejects MIME types not in the
inventory. A path with an unknown extension is not rejected; it uses
`application/octet-stream`. `.markdown` is not inferred as Markdown, and the
legacy viewer alias `text/x-markdown` is not accepted by `post_artifact`.

## Automated coverage

- `packages/api-contract/src/artifacts.test.ts` locks the 13 MIME types, 15
  recognized extensions, octet-stream fallback, and 25 MB ceiling.
- `apps/body/src/artifact-validation.test.ts` exercises every accepted MIME
  through upload validation.
- `apps/body/src/post-artifact.test.ts` exercises every recognized extension,
  case-insensitive inference, and unknown/extensionless fallback.
- `apps/mobile/sources/buzz/artifact.test.ts` locks all 39 MIME-by-surface
  preview/viewer capability rows.
- The `ArtifactCard`, `ArtifactViewer`, and `DesktopArtifactPane` component
  tests cover each renderer branch, external handoff, and failure state.

These are implementation tests. Existing Android emulator evidence in
`apps/mobile/evidence/artifacts/` covers representative HTML, SVG, Markdown,
PDF, and document-fallback cards; it is not a physical-device certification of
every row above.
