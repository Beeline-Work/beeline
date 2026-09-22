/**
 * Attachment bytes are temporary; the record of the attachment is not.
 *
 * A person-uploaded file or image lives in `objects` (Tigris) for
 * `MEDIA_TTL_HOURS` (24 by default, overridden once through the
 * `MEDIA_TTL_HOURS` environment variable). Agent artifacts live for
 * `ARTIFACT_TTL_HOURS` (seven days). The hourly sweep in `background.ts`
 * deletes the storage object and the row, and leaves an `object_expirations`
 * tombstone behind. Nothing else is touched: the message keeps its attachment
 * metadata, so a transcript still says a file was there, its name, its type
 * and its size.
 *
 * The tombstone is what makes "expired" a fact rather than a guess. Without it
 * a missing row is indistinguishable from an id that never existed, and both
 * the media endpoint (410 Gone vs 404) and the attachment projection
 * (`expired: true`) would have to conflate the two.
 */

/** Hours a media row survives after upload. */
export const MEDIA_TTL_HOURS = 24;
/** Hours an agent artifact survives after upload. */
export const ARTIFACT_TTL_HOURS = 7 * 24;
/** The sweep runs hourly; a TTL measured in hours needs no finer clock. */
export const MEDIA_SWEEP_INTERVAL_MS = 60 * 60 * 1_000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The single env override. A non-positive or unparseable value keeps the constant. */
export function mediaTtlHours(env: NodeJS.ProcessEnv = process.env): number {
  const hours = Number(env.MEDIA_TTL_HOURS);
  return Number.isFinite(hours) && hours > 0 ? hours : MEDIA_TTL_HOURS;
}

/** A media id is a UUID; anything else never named a row and must not reach a uuid cast. */
export function isMediaId(value: string): boolean {
  return UUID.test(value);
}

/** The media id an attachment URL names, absolute or origin-relative, or undefined. */
export function mediaIdFromUrl(url: string): string | undefined {
  const path = url.startsWith('/')
    ? url
    : (() => {
        try {
          return new URL(url).pathname;
        } catch {
          return '';
        }
      })();
  const id = path.startsWith('/v1/media/') ? path.slice('/v1/media/'.length) : '';
  return isMediaId(id) ? id.toLowerCase() : undefined;
}
