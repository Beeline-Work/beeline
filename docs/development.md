# Beeline development

## Product README

Edit the repository’s root `README.md` for the GitHub front page.

## Development

```sh
git clone https://github.com/Beeline-Work/beeline.git
cd beeline
npm install
npx turbo run build
npm run lint
npx turbo run test
```

The published CLI is a single bundled file built from `apps/body`:

```sh
npm run build -w @beeline/body
npm run build -w usebeeline     # esbuild apps/body/dist/cli.js -> packages/usebeeline/dist/usebeeline.mjs
```

Repository map:

```text
beeline/
├── apps/
│   ├── auth/          GitHub identity and repository install ceremony
│   ├── body/          The daemon: harness sessions, Room turns, corners, self-update
│   ├── mobile/        The phone app
│   └── server/        The monolith: Workspaces, Rooms, membership, grants
└── packages/
    ├── api-contract/  Shared vocabulary — faces, grants, system events
    ├── buzz-client/   Signed client for the indexed surfaces
    ├── nostr/         Schnorr-signed events and npub/nsec identity
    └── usebeeline/    This package
```

The product spec is [`spec.md`](https://github.com/Beeline-Work/beeline/blob/main/spec.md), agent-facing conventions live in [`CLAUDE.md`](https://github.com/Beeline-Work/beeline/blob/main/CLAUDE.md), and the UI contract lives in [`DESIGN.md`](https://github.com/Beeline-Work/beeline/blob/main/DESIGN.md).
