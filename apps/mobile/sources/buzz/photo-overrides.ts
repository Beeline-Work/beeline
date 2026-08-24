/**
 * Person/agent photo-override darkflight (owner decision, 2026-08-23): their
 * identity marks remain their only avatars and their picture-setting surfaces
 * stay hidden.
 *
 * Darkflight is deliberate, not deletion: storage and plumbing stay intact
 * (`buzz/avatar-upload.ts`, the profile/soul `avatar` fields), so stored photos
 * remain harmless data and nothing needs migrating if those photos return.
 */
export const PHOTO_OVERRIDES_ENABLED = false;

/** Workspace pictures are a workspace-only exception (owner decision,
 * 2026-08-24). They render through IdentityMark and fall back to the generated
 * workspace mark when absent or unavailable. */
export const WORKSPACE_PICTURES_ENABLED = true;
