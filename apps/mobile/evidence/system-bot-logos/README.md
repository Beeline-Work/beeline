# System bot logos

`dark.png` and `light.png` capture a browser build of the app's production
`IdentityMark`, `ConversationRow`, and `ToolDetailsCell` components at a 430 px
phone viewport. The rows use fixture identities and receipts. The header and
three bottom cards are proof layout wrappers around `IdentityMark`; they are
not a signed-in app session.

The captures show Trusty Squire, Wallet, System, Tailscale, Gmail, Google
Calendar, Google Drive, and YouTube. The System asset is served from the same
fixed-logo endpoint as the connectors. The test suite checks the real DM header,
list, and receipt card wiring separately.
