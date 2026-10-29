# Save to vault card

Feature verification; not a defect report. Reproduction `VAULT-CARD-1` names the same owner path throughout this evidence.

The production `VaultSaveCard` runs in a built Android development client on the corner's emulator. It submits to the built Beeline HTTP handler backed by isolated PGlite rows, and the helper calls the owner's real, existing Squire `store_credential` over its host MCP route. Production Beeline was not deployed or modified for this proof. The isolated proof uses loopback HTTP; the shipped route remains behind Beeline's HTTPS server and existing authenticated helper socket.

- `android-ask.png`: owner form, masked Password input, Show control and disabled Save.
- `android-type.png`: every required field filled, password masked, Save enabled.
- `android-saved.png`: real vault save succeeded; fields and values disappeared, leaving names and a server-issued saved time.
- `android-saved-obsidian.png`: the same settled card in Obsidian.

The throwaway service is `beeline-vault-card-test`, label `corner-c2c18ba268d2`. A runtime-generated password was typed through adb without printing it or putting it in a command transcript. Squire's metadata-only listing confirmed the entry and its `login` and `password` fields. Cleanup uses Squire's exact-action owner vouch; its completion is recorded in the PR.

Web was checked at the same production component entry with Squire: the owner sees Email and Password plus disabled Save, switching to another member removes both inputs and shows only the waiting card, and switching back restores the empty owner form.

`vault-save.test.ts` drives the actual HTTP handler and private helper storage function. It scans every Beeline base table and captured console output for the supplied sentinel, checks wrong-person refusal, helper offline/disconnect behavior, concurrent submission exclusion, and routing to the server holding the helper without PostgreSQL payloads. It also exercises the agent card operation and saved-command wake.

To repeat locally:

1. Build Body and Server, then run `node --import tsx scripts/prove-vault-save.mjs`.
2. Temporarily set the mobile package entry to `scripts/vault-save-native-proof.tsx`, start Metro, and open the built Android development client. Restore the normal entry before committing.
3. Enter throwaway values and save. The proof makes a real vault write under the named test service; remove that exact entry through Squire's approved deletion ceremony afterwards.
