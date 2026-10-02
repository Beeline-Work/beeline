# Release record — v0.1.0 supersede OTA (2026-09-30)

Owner request (Room 58182fc573457c185561b6962b4dc327324eec95667bb136873008ff1c2c84f9):
"Run another ota release. Supersede as v 0.1.0"

## Run

- Workflow: Unified production release (`unified-release.yml`, dispatch on `main`)
- Run: https://github.com/Beeline-Work/beeline/actions/runs/36730939779
- Result: **success** (completed ~15:11 UTC)
- Identity: `v0.1.0@076217de4a85c1d637dc72538049c4303839f856`
- Supersedes: v0.0.134@885f7b90b5eece8e99481d988611415a03f435ba

## No duplicate

Before reporting, verified no release run for head 076217de was in flight beyond
this one. Run 36730939779 was already queued on 076217de (planned identity
v0.1.0-076217de…) at 14:40:50Z; no second dispatch was issued.

## Plan (from `unified-release-plan-v0.1.0-076217de…`)

- Selected: server, helper, mobile-ota, desktop, website
- Carried: mobile-native v0.0.134@885f7b90 (runtime pins unchanged: android 32 / ios 31)
- OTA-only release (store_track none, runtime pin unchanged, no store submission)

## OTA promotion

- `mobile-ota-ledger.json`: `status: production`, `delivery.state: published`
  at 15:05:32Z, runId 36730939779, builtAt 15:03:53Z, canary post-promote
  recorded 15:04:32Z.
- 15 production update groups (listed_production_groups), targets:
  android@32/23/24/25/26/28/29/31, ios@23/24/25/26/27/29/31.
- `mobile-ota-promotion-proof.txt` confirms `release_version=v0.1.0`,
  `source_sha=076217de4a85c1d637dc72538049c4303839f856`, production targets
  listed across all 15 groups.

## Release record

- `unified-release-index` artifact: `state: delivered`, version v0.1.0,
  sourceSha 076217de…, supersedes v0.0.134.
- Per component (all `checked` at v0.1.0@076217de): server, helper, mobile-ota,
  desktop, website; mobile-native `carried` (v0.0.134).
- `gh release list` shows `v0.1.0` is now the repo's **latest** release
  (previously latest was v0.0.134; the August `v0.1.0` Buzzy release was the
  older tag the manifest-convergence check had refused). Manifest convergence
  passed this run.

## Device proof

- `release_proof` job skipped by design (OTA device proof is opt-in; default
  off). Record carries `proof: None` → OTA recorded UNPROVEN, per workflow
  policy.

## Post-promotion agent-tool check (Niglet request)

- Fresh agent turn after promotion: `search_history` (a beeline-agent tool)
  returned a well-formed structured result, so the beeline-agent MCP path
  answers with real output (the empty-result outage #1927 addressed is not
  present). The promoted head 076217de carries #1927.