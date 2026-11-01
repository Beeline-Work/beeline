# Audit of the nine stale-order reports

Read-only production SQL through the owner's vaulted Neon credential on October 31, 2026. No production messages, order bodies, attachments or tool activity are reproduced. Times below are UTC. The cohort reconstructed from production feedback summaries matches the problem file's nine reports, three reporter identities, time bounds and two reports after the 06:33 deploy. The problem file itself contains counts, not feedback IDs.

The original answered-blocker fix does not explain the entire cohort. Two reports carry the durable answered marker. A third exposes an additional delegate blocker path, now reproduced and fixed in this PR. The remaining six concern pending work already handled incidentally, independently resent, or still unaddressed. They have no durable marker saying a different turn fulfilled the queued instruction. Recorded claim times are current durable row evidence, not a claim-attempt audit log.

| Feedback | Command (and human source where different) | Production delivery trace | Verdict |
| --- | --- | --- | --- |
| `fb_b4afb20d672abab3738201b5` | `d93c7d5366fa01ee06cd3854fe179c8c9b97b5b2ae55c53e29b752932fbc6ca4` | Oct 30: queued 14:27:55; preceding order `9b0aff58f312db850e39a3cce5bf04cbb6d1f8015273f820493d92db215fa568` finished 14:33:22; recorded claim 14:33:23; complete 14:33:51. | New path: a retry order queued during prior work; no machine acknowledgement that the prior turn fulfilled it. No answered-report marker. |
| `fb_c7ef52ff6b8069979564ee4e` | `977bd7e4e227313b0401b08debd5f8af61e7dd58a306875418dfe77a47bdc344` | Queued Oct 30 22:32:43; commander sent delegate order `d7269e8475b69ed9541b11095d214f31e1b115a2347a48b63ac6b4951537584f` at 23:59:36 and `e86db9d827cf9788f27febfe59b6580ca67e58af9afccef269867a3fe0bb2a64` Oct 31 00:37:54; old report claimed 00:38:00, complete 00:38:23. No answered marker. | New path, reproduced and fixed in #3174: a non-implementer delegate report never entered the primary-worker blocker index. New provenance fence recognizes a later order from the recipient to the reporting delegate in the origin corner. |
| `fb_7b317afd4c061c7a804b76e0` | `9c87c3fc614639248fe305119616c674dd6f3c2d9ac63b975f8d926c8cb94e56` / source `5858e0db688e55548eb8f5d18c8407038be4b948c9ed6a78358d3a3179ee3055` | Oct 31: source/command created 03:40:08; response `06c4250513ee5c0a4dbcd013dbbc146512bd4e7862dc05ba37d635b74360252c` at 03:41:57 was attached to unrelated report request `14695b8ed934a646bed9ec9a14da4c7e2a57c61298dc82d425e34b9085371f44`; recorded source claim 03:44:26; complete 03:44:46. One command row for source. | New path: human input handled opportunistically in another request; no durable acknowledgement consumes this pending command. The later claim is not evidence that a completed command reopened. |
| `fb_194811f894fb780d068b024f` | `5181ee38287eb6c9688df95dbdf08b54dcad230532cbf1bc54479f2331503154` | Oct 31: queued 03:41:42; later commander order `b76d8617738b535c5ebf404fa185bdd3762f6d09ec463b26ed7975db35b17944` created 03:44:59; report claimed 03:46:18; complete 03:46:49; waitingAnswered=true. | Answered-blocker path, closed by #3174. The earlier approval `bb26d39df90a35be5d0789fb8dc92ee90c1ec1711397c400599c0badbf5694d0` was queued 03:41:22 but worker claimed it only at 03:41:47, after sending this report. |
| `fb_003e4fb2dce5bf5737ae52c5` | `fe099102bfca85ce8041fd441c3ec5addc66dfc3916bf04c50417c8f7cf4315f` / source `cb032a712f44e627089f022f51cc1a03d53307aa463b6fcc05f8eccf336f44d7` | Oct 31: source/command created 03:44:46; preceding request `70415acb30aea25b94498928664981f5a6d3873b9e3288df648a1e6012618af3` finished at 04:03:52 with response `67bbed7d95516fa31d8f15d1a9e49a5b5893b847f20524ce382ffcd360756ecc`; recorded source claim 04:03:52; complete 04:04:03. One command row for source. | New path: pending human input was considered handled in another request, without durable acknowledgement. No recorded reopening of a completed command. |
| `fb_0fd0fc28da34b3f6dd4e0107` | `85227ba94f5e7630fe0ec93abe880724d730e50c1af34f78d882ecba4679abcf` | Oct 31: queued 03:57:00; commander response 04:03:52 and resolved outcome 04:04:26; recorded claim 04:12:28; complete 04:12:49; waitingAnswered=true. | Answered-blocker path, closed by #3174; STALE-ANSWERED-REPORT. |
| `fb_6c2f728411e4897a34901cb0` | `c7af7be3963d8ae9753af1d774fb65e9faeb4ed36773b078b446d5c07f5b7b77` | Oct 31: resend queued 05:02:32; original order `ce9f8c6590ce807758bf62c77ff8d50b0f9d90735b1c652ee52eed5a6c7c755a` claimed 05:10:32, finished 05:11:34; resend claimed 05:11:35, complete 05:12:07; conflicting later order `e02f9c96466ed28185e0905a6f0ebf6d225993c596ba7a61d3f789c5532be228` queued 05:11:11. | New path: independently issued resend after an unclaimed order, not a duplicate command row. Plain order has no PR/head/fulfilled-command reference; server cannot safely infer redundancy from prose. |
| `fb_64923c160d5b9dbfa5ab53f7` | `06fcef95054b7d7ee035767084dfc49bfcf5b42a0489d98b0f9ced3383bc6345` / source `9ccd49f153442e4586fb21e3f07caf76fced115ec92dc0c4b51620f69b961a96` | Oct 31: revision command queued 02:16:49; running order `ae09cf4b1bcc7e6caafb5265bb5b1248e6aa8e8b60f2c574e9bf2bc29de4a50a` ended 06:48:22; revision/digest claimed 06:49:16, complete 06:54:59; repair orders `4f16dea00ad428d7736936cfd6e22c1ce2cc65c4bb4a66692c7b54dcee161be8` and `010a729c04fec276a8c55a9edbbb006ad27a524a7df17a65e75376981de68488` retained as absorbed sources. | New path: delayed first recorded digest consumption; the feedback says repairs remained unaddressed. Arrival-order queue behavior is explicit in main 80413d8c285f5294087a81f50514804ced169fc7 (#3073), not proof of settled work reopened. |
| `fb_b81df68d80356208c0a43c17` | `bf5d0184472e8a0d617dfaeb3117f697227f2e9a86d2b8ee8b8fa242a5004369` | Oct 31: repair order queued 07:44:40 during check-repair turn `e9390523afc3642cde03cf0223a3f6a3b3cfb96302d3ea0fbcf5690f8400ea6e`; check turn finished 07:50:14; recorded order claim 07:50:14, complete 07:51:23. Separate stale merge-conflict command `0a609a25287d8cf30421354200ac7b335cb614e19526ff69115283fbfe054a43` cancelled as superseded 07:49:09. | New path: plain repair order became redundant during an existing repair turn. No explicit fulfilled-order acknowledgement or structured head fence; not closed by #3001 or #3174. |

## New reproduction: STALE-DELEGATE-REPORT

Production delegate report `977bd7e4e227313b0401b08debd5f8af61e7dd58a306875418dfe77a47bdc344` reached its commander after that commander had sent newer orders to the same delegate. Its author was not the corner's primary implementer, so no primary-worker attention blocker existed and `waitingAnswered` was absent.

The isolated replay uses synthetic text: an implementer orders another member in its corner; that delegate reports blocked; cache that report; the implementer sends the delegate a newer order; attempt the cached claim and read the inbox. Before the added fence, both integration cases failed; the previously built PR head returned HTTP 200 and retained the blocker. With the fix, the same HTTP path returns HTTP 409 and excludes the blocker. The baseline proof swaps only the compiled command module to the previous PR head and restores it immediately; production is never replayed or mutated.

Run after building the server:

```sh
node --import tsx scripts/prove-answered-report.mjs --delegate
```

The new fence requires exact report-recipient/order-author, report-author/order-recipient, origin-corner and creation-order provenance. It applies only to blocked/needs-decision reports. Completed informational reports and active live claims survive. Digest sources use the existing stale-source rebuild path.

## Decision on the six pending-work cases

Ruby's decision: the following six reports are **redundant first delivery, expected; no fix in this corner**:

- `fb_b4afb20d672abab3738201b5`
- `fb_7b317afd4c061c7a804b76e0`
- `fb_003e4fb2dce5bf5737ae52c5`
- `fb_6c2f728411e4897a34901cb0`
- `fb_64923c160d5b9dbfa5ab53f7`
- `fb_b81df68d80356208c0a43c17`

In each case the work was still pending when the command was queued, and the redundant delivery finished in under six minutes. No completed command reopened. Main intentionally queues instructions behind active work (#3073). Explicit acknowledgement of pending command IDs would introduce a new protocol and is outside this corner's scope. PR #3174 remains limited to the reproduced answered-blocker and delegate-blocker paths.

