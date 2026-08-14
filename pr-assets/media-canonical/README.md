# Canonical chat-photo verification (Android API 36)

Device: `emulator-5554`, Android API 36, release APK built with Gradle
`--max-workers=2`. The device used its existing throwaway `Personal` identity;
no Room or Agent was created for this check.

The same 187 KB gallery JPEG was used before and after the change. Its JPEG
container had both an APP1 `Exif` segment (138 bytes) and an APP2
`ICC_PROFILE` segment (2,576 bytes).

- [Before](before-422.png): the unmodified main build uploads the gallery bytes
  directly and receives the relay's 422 metadata-policy response.
- [After](after-success.png): the patched release build re-encodes the photo,
  removes all APP and COM segments, uploads a 133 KB canonical JPEG, and sends
  it into the Room.

Buzz rejects APP1 through APP13, APP15, and COM before storage. A successful
upload therefore proves the stored blob has no EXIF/XMP, ICC, comment, or GPS
channel. The regression test also checks the exact pre-upload byte array and
asserts that `Exif`, `ICC_PROFILE`, and comment signatures are absent.
