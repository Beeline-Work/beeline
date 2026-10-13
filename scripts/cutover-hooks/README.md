# Retired monolith cutover hooks

`cutover-monolith.sh` and `production-hook.sh` always exit with a retirement
message. They cannot stop helpers, change runtime transports, roll back topology,
or issue an alternative production update. Legacy agent recovery now uses the
one-time signed server migration in `apps/server/src/auth.ts` and the independent
`npx usebeeline@latest update` entry. See [the helper channel](../../docs/cli-bundle-channel.md).

The remaining data/export scripts are historical operator evidence. They are
not invoked by helper startup, update, pairing or release.
