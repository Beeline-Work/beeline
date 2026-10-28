# Reproduction CONNECTORS-1

Production owner report: Settings → Connectors showed Slack, Supabase and whatsapp.com under Needs attention although none had completed sign-in. Production read-only SQL confirmed expired sign-in deadlines, no successful usage and no connected sign-in card for those apps.

The final production backfill dry run found **5 eligible rows**, including **3 for lunchboxfortwo**, before any production apply. The initial narrower query counted 4; the final predicate also includes offers that expired before authorization started. Production was not modified by this proof. The deployed maintenance job applies the cleanup in bounded batches; the schema backfill first preserves known successful connections through completed sign-in cards, usage, linked connection history and existing verified managed accounts. Vault keys are untouched.

`node --import tsx scripts/prove-connectors-cleanup.mjs` runs the built PhoneService against a disposable PGlite database shaped like the owner's data. It seeds the three unfinished apps plus previously authorized Notion with a revoked token. Dry run counts three; cleanup deletes those three; readWorkbench retains only Notion in Needs attention. Real local Rooms grants for Grok Bot and Meta Muse appear by name, alphabetically, in Connected apps.

For Android, add `--serve`, temporarily point the mobile entry at `scripts/connectors-cleanup-native-proof.tsx`, run Metro on port 18168 and install a debug build. The entry uses production native SettingsRow, AiClientsSection, section headers and phone-operation transport with the built local PhoneService fixture on port 18167. Only the local identity and upstream app provider are synthetic. It does not sign in as the production owner. The normal application entry was restored after capture.

- `android-bone.png` and `android-obsidian.png`: no unfinished sign-ins; the broken real app has Reconnect on its row; Grok Bot and Meta Muse share Connected apps.
- `android-disconnected.png`: tap Grok Bot → Disconnect; Grok Bot disappears without remounting; Meta Muse and Notion remain. The native action executes the built local PhoneService.

`connectors-cleanup.browser.test.ts` additionally mounts the actual Connectors route and production shared surface in both themes, holds a response started before Disconnect, and verifies that the later response cannot restore the removed row. `connector-removal.browser.test.ts` proves a failed real connection starts sign-in directly from the list without the former nested Disconnect sheet.
