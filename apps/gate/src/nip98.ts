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
export { buildNip98Event, nip98AuthHeader, NIP98_KIND } from '@buzzy/nostr';
