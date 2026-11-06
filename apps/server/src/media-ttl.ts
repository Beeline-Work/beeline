/** Upload retention metadata. Reads preserve existing expiration tombstones;
 * elapsed time does not run a storage or row cleanup job. */

/** Hours a media row survives after upload. */
export const MEDIA_TTL_HOURS = 24;
/** Hours an agent artifact survives after upload. */
export const ARTIFACT_TTL_HOURS = 7 * 24;

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
