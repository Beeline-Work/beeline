# Store submission

The operator runbook for the Google Play private beta and TestFlight lives
beside the mobile app: [`apps/mobile/docs/store-submission.md`](../apps/mobile/docs/store-submission.md).
It names the owner-supplied secrets and the one command: store uploads are the
`store_track` input of `.github/workflows/unified-release.yml`, so a store
build always comes from a released SHA.
