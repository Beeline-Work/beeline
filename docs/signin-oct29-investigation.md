# October 29 sign-in investigation

## Confirmed defect and fix

Reproduction R-MCP-SIGNIN-LEDGER: complete provider authorization through a Rooms
MCP browser callback. `TokenAuth.exchangeGoogleOidc` or `exchangeGitHubOidc`
issues a valid session, but the attempt ledger lacks `ticket_exchanged` and
maintenance subsequently labels the attempt expired. The phone HTTP handlers
were the only monolith session paths recording successful exchanges; MCP calls
`TokenAuth` directly and revokes the temporary phone session before showing
connection consent.

Record the exchange after credentials are committed in the shared `TokenAuth`
methods, removing the duplicate phone-route observations. This changes logging,
not provider verification, ticket consumption, consent or session issuance.
The native Android Google account picker remains enabled. There is no email
fallback and no production user was deleted.

The parameterized executable regression failed for both providers before the
patch: a valid session existed with only started, provider_returned and
ticket_issued observations. After the patch it includes ticket_exchanged and
cannot acquire an expired observation. A separate HTTP regression exercises
the actual MCP login/callback/consent path.

## Production evidence and limits

All timestamps below are UTC. No credential, provider token, authorization code
or recovery secret is included.

| Observation | Finding |
| --- | --- |
| Non-internal Google success, install `102ea219`, October 28 at 17:21:15–17:21:16 | Both callback_result success and signed_in were recorded by the server. This predates the attempt ledger's first event on October 29 at 06:17; absence from that later ledger is not evidence of a missing native-success path. |
| Google test success, install `e492fbd4`, October 29 at 18:54 | Attempt `797786ea` has started, provider_returned, ticket_issued and ticket_exchanged. |
| Null-context GitHub attempts `07dc606e` and `06f72885` at 18:28–18:29 | Corresponding bind tickets were consumed at 18:28:59.008 and 18:29:38.360, respectively, despite the ledger later showing expired. This disproves the claim that no ticket was redeemed. Missing platform/version alone does not identify an Android app failure. |
| Earlier null-context GitHub attempts | Their expired ticket rows were already absent at inspection. They cannot all be attributed to a person, test or client from this ledger alone. The current corner's device tests began after 19:03. |

The MCP source path and local executable reproduction establish the logging
defect. Consumed ticket rows alone do not prove that a particular historical
MCP client completed connection consent. No production history was rewritten.

## Shipped Android reproduction

Play-signed APK version 0.2.24, code 140, SHA-256
`b81bf9fb43c2266b31cbd9e84c81336e6546858c326acee1833377b6f53dcb84`
was installed on `dictation_api34`. Logcat confirmed live release v0.1.118,
commit `a9843bdd1dc557c944c1087df8aa9cb6f78cc44e`.

Reproduction R-GOOGLE-DEVICE-CHALLENGE: wipe app and Chrome data, launch the
shipped app, allow its live update to load, tap Continue with Google, and sign
in with the authorized existing Google account. Logcat shows Android's
CredentialSelectorActivity followed by Google's GoogleSignInActivity and
add-account flow. The password is accepted, then Google displays:

> Get a code to sign in
>
> This extra step helps make sure it‘s really you signing in
>
> To get your security code, go to g.co/sc in a new browser window

The security-code generator in the existing Squire browser requires a passkey;
Try another way offers only Use your passkey. The challenge remains unresolved.
This reproduces a started attempt without a provider return on a shipped app,
with a concrete external verification blocker; it does not establish the cause
of unrelated customer attempts.

| Test | Install / attempt | Outcome |
| --- | --- | --- |
| Native Google, wiped install, 19:42:59 | Internal install `be5a4b21-9a4f-431b-a71c-ceab3d7ad857`, attempt `adfc08bb-7c5c-4528-a59f-c0d235297e1a` | started; blocked on Google's security-code challenge before native completion; no callback or successful session claimed |
| Warm GitHub Home → icon return, 19:05:06 | Internal install `51993af1`, funnel attempt `4df266c6` | cancelled at 19:05:07.594; buttons become usable; retry opens GitHub |
| Repeat warm GitHub Home → icon return, 19:05:37 | Same install, funnel attempt `fe82e983` | cancelled at 19:05:39.518; no full sign-in claimed |

The Google recording, challenge screenshot, release/native-activity log and
matching production rows are retained under `evidence/signup-rerun/` in the
corner and posted as artifacts. The GitHub test credential's renewed reveal
expired without delivery, so four full GitHub sign-ins were not completed.
Ten wiped-install Google sign-ins, new-user signup and iOS remain unproven.

## Local validation

- Existing auth, mounted monolith OAuth and Rooms MCP suites passed (108 tests),
  including the new two-provider session-layer regression.
- The additional MCP HTTP ledger regression passed separately.
- Root `npm run typecheck` passed, including mobile and scripts.

No claim is made that this logging patch resolves Google's external device
verification. Shipped end-to-end proof still requires a verification-capable
account/device route and usable GitHub test credentials.
