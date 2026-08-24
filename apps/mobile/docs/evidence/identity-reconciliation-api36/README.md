# Identity reconciliation emulator evidence

Captured on the Android API 36 emulator at 1080 × 2400 from the production React Native onboarding components and Grok Mono Hull design system.

The capture APK used a deterministic, debug-only identity state so the post-auth states could be reviewed without publishing a test identity or completing a live GitHub OAuth ceremony. The capture scaffold and one-off runtime override were removed before validation and are not part of the shipped code. The Identity Settings frame stages the hosted identifier in the real profile field without pressing Save, so it performs no local or relay profile write.

- [Key-only handle ceremony](./handle-ceremony.png)
- [GitHub login with automatic hosted handle](./github-auto-handle.png)
- [Profile with verified NIP-05 and same-key link status](./profile-nip05.png)
- [Identity Settings with the hosted NIP-05 field](./profile-settings-nip05.png)
