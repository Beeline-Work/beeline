# Buzzy

The merge you hold from your phone. See [`spec.md`](./spec.md) for the full
design.

This is a Turborepo monorepo with npm workspaces, mirroring the
[speakeasy](../proj-speakeasy/speakeasy) stack (Turborepo, npm workspaces,
bare React Native, Fastify + ws) — with one deliberate difference: **Buzzy's
signing layer is Nostr, not Signal.** `packages/crypto`'s Signal protocol has
no equivalent here; `packages/nostr` (schnorr-signed events, npub/nsec
identity) is the product's differentiator, not a borrowed primitive.

## Layout

```
apps/
  api/        Fastify + ws shell. Will host the Phase 0 merge-gate worker
              (spec.md, "Build sequence") — not implemented yet.
  mobile/     Bare React Native 0.77, Hermes, new architecture.
              Empty shell today; Phase 3 forks Happy's mobile client here
              and implements the RigTransport adapter (spec.md,
              "RigTransport adapter — MVP method list").
packages/
  nostr/      Keygen, event sign/verify, npub/nsec encoding.
              @noble/curves (secp256k1 schnorr) does the actual signing;
              nostr-tools handles NIP-19 bech32 encoding.
spec.md       Authoritative product spec.
```

## Status

Scaffolding only — this prepares Phase 3's home ("Fork Happy + the
`RigTransport` adapter") per `spec.md`'s build sequence. Phases 0–2 (the
merge gate itself, proven headless) are not built here.

## Building from source

```sh
npm install
npx turbo run build
npx turbo run typecheck
npx turbo run test
```

`packages/nostr`'s tests generate a keypair, sign an event, verify it, and
assert that a tampered event or a wrong-key signature is rejected.

Android APK (not attempted yet — the RN project is configured for it but
untested against the SDK):

```sh
cd apps/mobile/android
./gradlew :app:assembleDebug
```

## License

This code is currently unlicensed.
