# Agent wallet tools

Wallet tools use the authenticated agent's linked owner's EVM account. The
client sends the agent's actual identity and the active Room or corner; the
server rejects a different identity. Workbench shows Wallet connected while
that owner's signing delegation is active. Wallet has no machine connector row.

## Chains

`wallet_balance`, `wallet_quote`, `wallet_chains` and `wallet_history` read
every chain `wallet_chains` lists, in parallel. CDP's token-balances endpoint
covers only Base and Ethereum, so every other chain (and any CDP failure) reads
the native balance (`eth_getBalance`) and USDC (`balanceOf`) from the chain's
public RPC. Each holding carries its `chain`; `hasBalance` and quotes use the
same holdings. A chain that cannot be read is listed in `unreadChains` rather
than shown as zero. Chain facts live in `apps/server/src/evm-chain.ts`.

`wallet_pay` sends the chain's native token or USDC as an EIP-1559 transaction
through CDP `send/transaction` (Base, Ethereum, Arbitrum, Optimism, Polygon,
Avalanche). On Zora and BNB Chain, CDP signs the transaction
(`sign/transaction`) and the server broadcasts it through the public RPC.

`wallet_swap` uses CDP's swap API (`POST /evm/swaps`) on Base, Ethereum,
Arbitrum, Optimism and Polygon. An ERC-20 sell approves Permit2 first when the
quote reports a missing allowance. Other chains fail with
`swap unsupported on <chain>`. After submission, the swap receipt is checked
for up to one minute. `sent` means a successful receipt; a reverted receipt
returns `failed` with the transaction hash. Missing receipts or RPC failures
return `pending` with the transaction link. Do not resubmit a pending swap.
Failed and pending swaps do not credit quoted output or write a success ledger entry.

CDP v2 has no address history for server wallets. Each balance read compares
every chain and asset with the last snapshot (`wallet_balance_snapshots`); an
increase is recorded as one inbound ledger entry with the counterparty
`deposit (sender not indexed)` and no transaction link. A swap's quoted output
is credited to the snapshot so it is not read as a deposit.

## Contract calls

`wallet_contract_call` calls one contract on one chain with ABI-encoded call
data (`data`) and an optional native `value`. It serves venues that take an
approve and a call: bridges such as CCTP, lending, vaults. With `approve`
(`{ asset, amount }`), the server first sends an ERC-20 `approve` for exactly
that amount to the contract, waits for it to be mined, then sends the call.
Call data that grants an allowance itself (`approve`, `increaseAllowance`,
`setApprovalForAll`) is refused, so no call can approve an unlimited amount.

The call's spends are the native value, the approved amount and a USDC
`transfer` encoded in the call data. They pass the same checks as `wallet_pay`:
the owner's signing delegation, the venue rules below and the funded balance.
A successful call writes one `@wallet` ledger line naming the agent, the spends
and the contract.

## Venue rules

`apps/server/src/wallet-venues.ts` holds one table of deposit rules: a venue's
deposit address on a chain, the one asset it credits and the smallest amount
it credits. `wallet_pay` checks every send against it, and
`wallet_contract_call` checks every spend. A transfer the venue would never
credit fails with the reason, before anything is sent. Adding a venue is one
table entry.

| Venue | Chain | Address | Asset | Minimum | Source |
| --- | --- | --- | --- | --- | --- |
| Hyperliquid Bridge2 | arbitrum | `0x2Df1c51E09aECF9cacB7bc98cB1742757f163dF7` | USDC | 5 | Hyperliquid docs, USDC > Legacy Bridge |

To deposit into Hyperliquid, `wallet_pay` at least 5 USDC on Arbitrum to
Bridge2; it is credited to the same address on Hyperliquid.

## Typed data

`wallet_sign_typed_data` accepts the four EIP-712 fields: `domain`, `types`,
`primaryType` and `message`. For example, a harmless signing probe is:

```json
{
  "domain": {
    "name": "Exchange",
    "version": "1",
    "chainId": 1337,
    "verifyingContract": "0x0000000000000000000000000000000000000000"
  },
  "types": { "BeelineTest": [{ "name": "notice", "type": "string" }] },
  "primaryType": "BeelineTest",
  "message": { "notice": "Harmless signing test; no order or transfer" }
}
```

When `types` has no `EIP712Domain`, the server derives it from the domain
fields present (name, version, chainId, verifyingContract, salt), because CDP
requires it. Otherwise the server forwards the fields unchanged to CDP's
[Sign EIP-712 typed data endpoint](https://docs.cdp.coinbase.com/api-reference/v2/rest-api/evm-accounts/sign-eip-712-typed-data)
for the linked EVM address. Signing has no chain allowlist and does not broadcast
anything. CDP policies can still refuse a payload. Beeline returns
`{ "outcome": "signed", "signature": "0x…" }` on success, `delegation-expired`
when the owner's signing delegation is inactive, or `failed` with a reason.
Payloads must contain objects for domain, types and message, a primary type
present in types, and named typed fields; the serialized payload is limited to
64 KB. CDP validates EIP-712 semantics.

Typed-data signatures can authorize transfers, including Permit messages. This
tool uses the same requester-scoped Wallet resource approval and owner signing
delegation as `wallet_pay` and `wallet_swap`. A required resource approval
returns `permission-required`; a once grant is consumed by the call. Yolo does
not bypass the owner's signing delegation.

Each successful signature writes a Wallet audit card with the agent, account,
domain, primary type and payload SHA-256. The reusable signature is returned only
to the caller; it is not stored in the audit. Signing is not recorded as a
transfer and does not change a balance.

Run `npm run prove:wallet-tools`
to exercise the built client through a local HTTP server with an unfunded fake
CDP source. It demonstrates owner wallet reads, Workbench connection and harmless
Exchange-domain signing with chainId 1337, and prints the result. It cannot
establish live CDP policy acceptance. No orders, deposits or transfers are sent.
