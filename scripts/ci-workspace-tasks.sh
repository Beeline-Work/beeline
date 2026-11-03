#!/usr/bin/env bash
set -euo pipefail

# TYPECHECK runs its checks sequentially; MOBILE SUITE owns a separate checkout.
# Keep trusted-base architecture and phone/UI policy checks equivalent to TYPECHECK.

typecheck() {
  # Enforce the shared UI component registry
  export UI_POLICY_BASE="$CI_BASE_SHA"
  git fetch --no-tags --depth=1 origin "$UI_POLICY_BASE"
  node --test --test-concurrency=1 scripts/mobile-ui-policy.test.mjs
  node scripts/check-mobile-ui-components.mjs --base "$UI_POLICY_BASE"
  # Allow no phone network channel besides the main live socket
  export CHANNEL_BASE="$CI_BASE_SHA"
  git fetch --no-tags --depth=1 origin "$CHANNEL_BASE"
  node --test --test-concurrency=1 scripts/phone-network-channels.test.mjs
  node scripts/check-phone-network-channels.mjs --base "$CHANNEL_BASE"
  node --test --test-concurrency=1 scripts/router-boundaries.test.mjs
  node scripts/check-router-boundaries.mjs --base "$CHANNEL_BASE"
  # Keep each module's sinks in their owner files
  export ARCHITECTURE_BASE="$CI_BASE_SHA"
  git fetch --no-tags --depth=1 origin "$ARCHITECTURE_BASE"
  node --test --test-concurrency=1 scripts/check-architecture.test.mjs
  runner=scripts
  if git cat-file -e "$ARCHITECTURE_BASE:scripts/check-architecture.mjs" 2>/dev/null; then
    runner="$RUNNER_TEMP/architecture-guard"
    mkdir -p "$runner"
    for file in check-architecture.mjs architecture-invariants.mjs architecture-storage.mjs; do
      git show "$ARCHITECTURE_BASE:scripts/$file" > "$runner/$file" 2>/dev/null || rm -f "$runner/$file"
    done
  fi
  if [ "$GITHUB_EVENT_NAME" = "pull_request" ]; then
    node "$runner/check-architecture.mjs" --root . --base "$ARCHITECTURE_BASE"
  else
    node "$runner/check-architecture.mjs" --root .
  fi
  # The root command also generates mobile routes and typechecks mobile.
  node --test scripts/rollout-schema.test.mjs
  node scripts/rollout-schema.mjs --previous "$CI_BASE_SHA"
  npm run typecheck
  # Check no workflow names a deleted test
  npm run lint:workflow-paths
  # Check path filters skip untouched suites
  node --test --test-concurrency=1 scripts/workflow-change-filter.test.mjs scripts/ci-shards.test.mjs scripts/ci-workflow.test.mjs scripts/server-test-selection.test.mjs scripts/ci-baseline.test.mjs scripts/ci-workspace-lanes.test.mjs
  node --test --test-concurrency=1 scripts/ci-build-provenance.test.mjs scripts/ci-task-cache.test.mjs scripts/workspace-test-selection.test.mjs scripts/run-workspace-tests.test.mjs scripts/report-main-checks.test.mjs
  # Test nightly Checks orchestration
  node --test --test-concurrency=1 scripts/nightly-checks.test.mjs
}


mobile_suite() {
  # Run the mobile vitest suite
  node scripts/run-workspace-tests.mjs mobile
  # Verify Android release shrinking mods
  node --test --test-concurrency=1 scripts/android-shrinking.test.mjs
  # Prove Android cached update integrity and retry
  node --test --test-concurrency=1 scripts/android-ota-integrity.test.mjs
}


dead_code() {
  # Reject new unused files or exports
  timeout 5m npm run dead-code
  # Prove an unused export fails the guard
  timeout 5m npm run test:dead-code
}


native_fingerprint() {
  # Compare the native fingerprint with the committed runtime pin
  ( cd "apps/mobile"
    npm run fingerprint:check
  )
  # Run the native fingerprint regression in isolation
  ( cd "apps/mobile"
    npx vitest run sources/config/nativeFingerprint.test.ts --maxWorkers=1 --minWorkers=1
  )
}


mobile_export_reachability() {
  # Export Android bundle
  ( cd "apps/mobile"
    npx expo export --max-workers 1 --platform android --output-dir "$RUNNER_TEMP/mobile-export" --clear
  )
  # Prove the export produced an Android bundle
  set -euo pipefail
  test -n "$(find "$RUNNER_TEMP/mobile-export/_expo/static/js/android" -name '*.hbc' -o -name '*.js' | head -n 1)"
  # Reject transcript measurement code in the normal bundle
  set -euo pipefail
  if grep -aREl 'transcript-speed/|__transcriptSpeed|__transcriptBuild' "$RUNNER_TEMP/mobile-export/_expo/static/js/android"; then
    echo 'Normal Android bundle contains transcript measurement code'
    exit 1
  fi
}


case "${1:?expected a workspace check name}" in
  typecheck) typecheck ;;
  mobile-suite) mobile_suite ;;
  dead-code) dead_code ;;
  native-fingerprint) native_fingerprint ;;
  mobile-export-reachability) mobile_export_reachability ;;
  *) echo "Unknown workspace check: $1" >&2; exit 2 ;;
esac
