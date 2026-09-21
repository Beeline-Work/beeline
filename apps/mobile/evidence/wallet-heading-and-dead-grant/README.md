# Wallet heading and grant-failure frames

Captured on `emulator-5556` (buzzy_api36, 1080×2400) from this branch's Expo
development client, pointed at an isolated local monolith
(`EXPO_PUBLIC_BUZZY_MONOLITH_URL=http://127.0.0.1:8796`) and signed in as the
Play review identity via `beeline://review/<secret>`. The wallet was created
on the one fixed welcome Workspace (`bee11e00-0000-4000-8000-000000000001`)
through the real `createWallet` path; the CDP seam is the fake (no production
credential). The screen is the production `wallet.tsx` module.

The grant press is a real `grantDelegation` → `grantWalletDelegation` HTTP
call. The fixture delayed that one operation 2.5s and answered 503
`{ error: "wallet not created" }` — the sentence `grantWalletDelegation`
throws in `apps/server/src/wallet.ts` when there is no binding. The component
was not mocked.

| file | shows |
| --- | --- |
| `heading.png` | In-page header: back chevron, **Wallets**, subtitle **Coinbase CDP Server Wallet** (the CDP Server-Wallet model in `cdp-client.ts`) |
| `banner-idle.png` | Permission-expired banner, trailing `grant` |
| `banner-inflight.png` | Same press in flight: brass pulse + `Granting…` |
| `banner-failed.png` | After the real refusal: danger subtitle `wallet not created`, `grant` still there |
