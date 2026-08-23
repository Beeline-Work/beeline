/**
 * Photo-override darkflight (owner decision, 2026-08-23): identity marks are
 * the ONLY avatars on the product surface. Every picture-setting UI gates on
 * this one flag — flip it to `true` to revive all of them at once.
 *
 * Darkflight is deliberate, not deletion: storage and plumbing stay intact
 * (`buzz/avatar-upload.ts`, the profile/community/soul `avatar` fields,
 * `IdentityMark`'s already-dark relay-photo path), so stored photos remain
 * harmless data and nothing needs migrating if photos ever return.
 */
export const PHOTO_OVERRIDES_ENABLED = false;
