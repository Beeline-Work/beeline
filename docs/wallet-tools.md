# Agent wallet tools

Wallet tools use the authenticated agent's linked owner's EVM account. The
client sends the agent's actual identity and the active Room or corner; the
server rejects a different identity. Workbench shows Wallet connected while
that owner's signing delegation is active. Wallet has no machine connector row.

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

The server forwards those fields unchanged to CDP's
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
