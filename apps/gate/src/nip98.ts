/**
 * NIP-98 (kind:27235) HTTP-auth header for the Buzz git smart-HTTP transport.
 *
 * The relay's git auth extractor (buzz-relay `api/git/transport.rs`) reads the
 * `Authorization: Nostr <base64(event-json)>` header, base64-STANDARD-decodes
 * it to a signed kind:27235 event, and requires:
 *   - a `["u", <repo-root-url>]` tag matching the request URL with the git
 *     service suffix (`/info/refs`, `/git-upload-pack`, `/git-receive-pack`)
 *     stripped — so ONE header authenticates both the info/refs GET and the
 *     receive-pack POST of a single push;
 *   - a `["method", <verb>]` tag (NOT actually enforced for git routes — the
 *     server reads the verb from the event itself — but included for correctness);
 *   - `created_at` within +-60s of server time.
 *
 * We inject this directly via `git -c http.extraHeader=...` instead of the
 * `git-credential-nostr` helper: that helper emits the git >=2.46 `authtype`/
 * `credential` capability, which the installed git 2.43 silently ignores.
 */
import { signEvent, type NostrEvent } from '@buzzy/nostr';

export const NIP98_KIND = 27235;

/** Build a signed NIP-98 event for a git repo-root URL. */
export function buildNip98Event(
  secretKey: Uint8Array,
  pubkeyHex: string,
  url: string,
  method: string,
): NostrEvent {
  return signEvent(
    {
      pubkey: pubkeyHex,
      created_at: Math.floor(Date.now() / 1000),
      kind: NIP98_KIND,
      tags: [
        ['u', url],
        ['method', method.toUpperCase()],
      ],
      content: '',
    },
    secretKey,
  );
}

/** Produce the full `Authorization` header value (`Nostr <base64>`). */
export function nip98AuthHeader(
  secretKey: Uint8Array,
  pubkeyHex: string,
  url: string,
  method: string,
): string {
  const event = buildNip98Event(secretKey, pubkeyHex, url, method);
  const b64 = Buffer.from(JSON.stringify(event), 'utf8').toString('base64');
  return `Nostr ${b64}`;
}
