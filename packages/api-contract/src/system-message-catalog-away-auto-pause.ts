export const SYSTEM_MESSAGE_AWAY_AUTO_PAUSE = {

  'away-auto-pause.warning': { parts: ['will pause schedules and subscriptions for'], variables: [] },

  'away-auto-pause.come-back': { parts: ['You have been away for 3 days. Come back within 1 day to keep them running. After they pause, ask your agent to resume.'], variables: [] },

  'agent-command.agent-mention': {
    parts: ['@', ''],
    variables: ['target_handle'],
  },

  'agent-command.did-not': {
    parts: ['did not ', ''],
    variables: ['action'],
  },

  'agent-command.did-not-sign-in': {
    parts: ['did not sign in'],
    variables: [],
  },

  'agent-command.did-not-take-a-new-key': {
    parts: ['did not take a new key'],
    variables: [],
  },

  'agent-command.did-not-sign-in-to': {
    parts: ['did not sign in to ', ''],
    variables: ['AGENT_SIGN_IN_SERVICE_LABELS'],
  },

  'agent-command.only-its-owner-may-sign-it-in': {
    parts: ['only its owner may sign it in'],
    variables: [],
  },

  'agent-command.sign-in-from-beeline-is-not-available-for-its-harness': {
    parts: ['sign-in from Beeline is not available for its harness'],
    variables: [],
  },

  'agent-command.asked-for-a-new-key': {
    parts: ['asked for a new key'],
    variables: [],
  },

  'agent-command.started-a-sign-in': {
    parts: ['started a ', ' sign-in'],
    variables: ['AGENT_SIGN_IN_SERVICE_LABELS'],
  },

  'agent-command.its-owner-finishes-it-in-this-card': {
    parts: ['its owner finishes it in this card'],
    variables: [],
  },

  'agent-command.supports-lifecycle-commands': {
    parts: ['supports lifecycle commands'],
    variables: [],
  },

  'agent-command.restart-status-stop-retry-debug-help-login': {
    parts: ['restart · status · stop · retry · debug · help · /login'],
    variables: [],
  },

  'agent-command.is-online': {
    parts: ['is online'],
    variables: [],
  },

  'agent-command.is-offline': {
    parts: ['is offline'],
    variables: [],
  },

  'agent-command.one-turn-is-running': {
    parts: ['one turn is running'],
    variables: [],
  },

  'agent-command.no-turn-is-running': {
    parts: ['no turn is running'],
    variables: [],
  },

  'agent-command.lifecycle': {
    parts: ['lifecycle ', ''],
    variables: ['target_lifecycle_id_unknown'],
  },

  'agent-command.unknown': {
    parts: ['unknown'],
    variables: [],
  },

  'agent-command.release': {
    parts: ['release ', ''],
    variables: ['target_release_version_unknown'],
  },

  'agent-command.source': {
    parts: ['source ', ''],
    variables: ['target_source_sha_slice_0'],
  },

  'agent-command.turn': {
    parts: ['turn ', ''],
    variables: ['active_request_id'],
  },

  'agent-command.no-active-turn': {
    parts: ['no active turn'],
    variables: [],
  },

  'agent-command.reported-diagnostics': {
    parts: ['reported diagnostics'],
    variables: [],
  },

  'agent-command.separator': {
    parts: [' · '],
    variables: [],
  },

  'agent-command.has-nothing-to-stop': {
    parts: ['has nothing to stop'],
    variables: [],
  },

  'agent-command.stopped-its-running-turn': {
    parts: ['stopped its running turn'],
    variables: [],
  },

  'agent-command.queued-dropped': {
    parts: ['', ' queued ', ' dropped'],
    variables: ['dropped', 'dropped_1_order_orders'],
  },

  'agent-command.order': {
    parts: ['order'],
    variables: [],
  },

  'agent-command.orders': {
    parts: ['orders'],
    variables: [],
  },

  'agent-command.has-no-failed-turn-to-retry': {
    parts: ['has no failed turn to retry'],
    variables: [],
  },

  'agent-command.queued-a-retry-for-its-last-failed-turn': {
    parts: ['queued a retry for its last failed turn'],
    variables: [],
  },

  'agent-command.already-has-a-restart-in-progress': {
    parts: ['already has a restart in progress'],
    variables: [],
  },

  'agent-command.queued-a-restart': {
    parts: ['queued a restart'],
    variables: [],
  },

  'agent-command.running-turn-will-drain-first': {
    parts: ['running turn will drain first'],
    variables: [],
  },

  'agent-command.helper-will-reconnect-to-confirm': {
    parts: ['helper will reconnect to confirm'],
    variables: [],
  },

  'agent-command.1-hour': {
    parts: ['1 hour'],
    variables: [],
  },

  'agent-command.failed-queued-dropped-by-a-stop-the-running-turn-was-cancelled': {
    parts: ['failed: ', ' queued ', ' dropped by a Stop; the running turn was cancelled'],
    variables: ['dropped_rowCount', 'dropped_rowCount_1_order_was'],
  },

  'agent-command.order-was': {
    parts: ['order was'],
    variables: [],
  },

  'agent-command.orders-were': {
    parts: ['orders were'],
    variables: [],
  },

  'agent-command.pull-request': {
    parts: ['pull request #', ''],
    variables: ['row_number'],
  },

  'agent-command.this-head': {
    parts: ['this head'],
    variables: [],
  },

  'agent-command.requested-another-check-of': {
    parts: ['requested another check of'],
    variables: [],
  },

  'agent-command.checks-fail-on-and-a-check-has-not-finished-for': {
    parts: ['checks fail on ', ' and a check has not finished for ', ''],
    variables: ['pullRequest', 'CORNER_CHECK_STUCK_AFTER'],
  },

  'agent-command.checks-still-fail-on-and-the-fix-turn-ended-with-nothing-new-push': {
    parts: ['checks still fail on ', ' and the fix turn ended with nothing new pushed'],
    variables: ['pullRequest'],
  },

  'agent-command.found-failing-checks-on': {
    parts: ['found failing checks on'],
    variables: [],
  },

  'agent-command.blocked-pr-is-a-draft-marking-it-ready-for-review-failed': {
    parts: ['blocked: PR is a draft; marking it ready for review failed'],
    variables: [],
  },

  'agent-command.found-merge-conflicts-in': {
    parts: ['found merge conflicts in'],
    variables: [],
  },

  'agent-command.github': {
    parts: ['GitHub'],
    variables: [],
  },

  'agent-command.passed-checks': {
    parts: ['passed checks'],
    variables: [],
  },

  'agent-command.aggregate-checks': {
    parts: ['aggregate checks'],
    variables: [],
  },

  'agent-schedules.the-schedule': {
    parts: ['The ', ' schedule'],
    variables: ['current_workflow_slug'],
  },

  'agent-schedules.skipped-a-run': {
    parts: ['skipped a run'],
    variables: [],
  },

  'agent-schedules.run-is-active-at-step-in-state-for-min': {
    parts: ['run ', ' is active at step ', ' in state ', ' for ', ' min'],
    variables: ['live_runId', 'live_state', 'live_status', 'elapsedMinutes'],
  },

  'agent-sign-in.sign-in-failed-on-the-agent-machine': {
    parts: ['Sign-in failed on the agent machine.'],
    variables: [],
  },

  'agent-subscriptions.beeline': {
    parts: ['Beeline'],
    variables: [],
  },

  'agent-subscriptions.received': {
    parts: ['received'],
    variables: [],
  },

  'agent-subscriptions.a-slack-message': {
    parts: ['a Slack message'],
    variables: [],
  },

  'agent-subscriptions.channel-name': {
    parts: ['#', ''],
    variables: ['row_service_channel_name'],
  },

  'app-connections.app-sign-in-needs-attention': {
    parts: ['App sign-in needs attention'],
    variables: [],
  },

  'app-connections.app-sign-in-timed-out-open-the-connection-card-and-sign-in-again': {
    parts: ['App sign-in timed out. Open the connection card and sign in again.'],
    variables: [],
  },

  'app-connections.app-sign-in-is-unavailable': {
    parts: ['App sign-in is unavailable'],
    variables: [],
  },

  'app-connections.app-connection-could-not-be-checked-try-again': {
    parts: ['App connection could not be checked. Try again.'],
    variables: [],
  },

  'app-connections.the-mcp-connection-was-removed-reconnect-it': {
    parts: ['The MCP connection was removed; reconnect it'],
    variables: [],
  },

  'app-connections.connection-failed': {
    parts: ['Connection failed'],
    variables: [],
  },

  'app-connections.connect-trusty-squire-in-connectors-first': {
    parts: ['Connect Trusty Squire in Connectors first'],
    variables: [],
  },

  'app-connections.its-vault-key-needs-attention-in-trusty-squire': {
    parts: ['Its vault key needs attention in Trusty Squire'],
    variables: [],
  },

  'app-connections.app-sign-in-failed': {
    parts: ['App sign-in failed'],
    variables: [],
  },

  'commander.stopped': {
    parts: ['stopped'],
    variables: [],
  },

  'commander.s-running-turn': {
    parts: ['', "'s running turn"],
    variables: ['systemIdentityMention_worker_kind_agent'],
  },

  'commander.queued-dropped': {
    parts: ['', ' queued ', ' dropped'],
    variables: ['dropped', 'dropped_1_order_orders'],
  },

  'commander.order': {
    parts: ['order'],
    variables: [],
  },

  'commander.orders': {
    parts: ['orders'],
    variables: [],
  },

  'commander.ordered': {
    parts: ['ordered'],
    variables: [],
  },

  'commander.reported-to': {
    parts: ['reported to'],
    variables: [],
  },

  'computer-session.browser': {
    parts: ['Browser'],
    variables: [],
  },

  'computer-session.shared': {
    parts: ['shared'],
    variables: [],
  },

  'computer-session.a-live-browser': {
    parts: ['a live browser'],
    variables: [],
  },

  'connection-presence.agent-mention': {
    parts: ['@', ''],
    variables: ['restart_handle'],
  },

  'connection-presence.reconnected-after-restart': {
    parts: ['reconnected after restart'],
    variables: [],
  },

  'connector-offer-completion.reconnected': {
    parts: ['reconnected'],
    variables: [],
  },

  'connector-offer-completion.added': {
    parts: ['added'],
    variables: [],
  },

  'connector-offer-completion.reconnected-automatically': {
    parts: ['reconnected automatically'],
    variables: [],
  },

  'corner-holds.set-a-merge-hold': {
    parts: ['set a merge hold'],
    variables: [],
  },

  'corner-holds.citation': {
    parts: ['', ': “', '”'],
    variables: ['citation_source_name', 'citation_source_text'],
  },

  'corner-lifecycle.system': {
    parts: ['@system'],
    variables: [],
  },

  'corner-lifecycle.opened': {
    parts: ['opened'],
    variables: [],
  },

  'corner-lifecycle.corner': {
    parts: ['corner'],
    variables: [],
  },

  'corner-lifecycle.handed-off': {
    parts: ['handed off'],
    variables: [],
  },

  'corner-lifecycle.pushed': {
    parts: ['pushed'],
    variables: [],
  },

  'corner-lifecycle.revision-work': {
    parts: ['revision_work'],
    variables: [],
  },

  'corner-lifecycle.rechecked': {
    parts: ['rechecked'],
    variables: [],
  },

  'corner-lifecycle.merge-unconfirmed': {
    parts: ['merge_unconfirmed'],
    variables: [],
  },

  'corner-lifecycle.could-not-confirm-the-merge-of': {
    parts: ['could not confirm the merge of'],
    variables: [],
  },

  'corner-lifecycle.pull-request': {
    parts: ['pull request #', ''],
    variables: ['event_number'],
  },

  'corner-lifecycle.merge-outcome-is-unconfirmed': {
    parts: ['', ' · merge outcome is unconfirmed'],
    variables: ['event_error'],
  },

  'corner-lifecycle.pr-closed': {
    parts: ['pr_closed'],
    variables: [],
  },

  'corner-lifecycle.landed': {
    parts: ['landed'],
    variables: [],
  },

  'corner-lifecycle.closed': {
    parts: ['closed'],
    variables: [],
  },

  'corner-lifecycle.the-configured-reviewer-is-unreachable-or-unhealthy': {
    parts: ['the configured reviewer is unreachable or unhealthy'],
    variables: [],
  },

  'corner-lifecycle.the-corner-has-no-implementer': {
    parts: ['the corner has no implementer'],
    variables: [],
  },

  'corner-lifecycle.the-reviewer-command-could-not-be-queued-on-restore-reviewer-acce': {
    parts: [
      'the reviewer command could not be queued on ',
      '',
      '; restore reviewer access or choose an available reviewer',
    ],
    variables: ['headSha_this_head', 'queued_error_queued_error'],
  },

  'corner-lifecycle.this-head': {
    parts: ['this head'],
    variables: [],
  },

  'corner-lifecycle.dispatch-error': {
    parts: [': ', ''],
    variables: ['queued_error'],
  },

  'corner-lifecycle.approved': {
    parts: ['approved'],
    variables: [],
  },

  'corner-lifecycle.no-reviewer-is-configured': {
    parts: ['no reviewer is configured'],
    variables: [],
  },

  'corner-lifecycle.blocked': {
    parts: ['blocked: ', ''],
    variables: ['reason'],
  },

  'corner-lifecycle.the-implementer-cannot-be-woken-to-arrange-review': {
    parts: ['The implementer cannot be woken to arrange review'],
    variables: [],
  },

  'corner-lifecycle.the-reviewer-completed-its-review-of-the-current-head': {
    parts: ['the reviewer completed its review of the current head', ''],
    variables: ['evidence_prior_verdict_and_evidence'],
  },

  'corner-lifecycle.prior-verdict-and-evidence': {
    parts: ['; prior verdict and evidence: ', ''],
    variables: ['evidence'],
  },

  'corner-lifecycle.requested-review-of': {
    parts: ['requested review of'],
    variables: [],
  },

  'corner-lifecycle.unknown-dispatch-error': {
    parts: ['unknown dispatch error'],
    variables: [],
  },

  'corner-lifecycle.no-reviewer-on-the-configured-list-is-healthy-enough-to-continue': {
    parts: ['no reviewer on the configured list is healthy enough to continue'],
    variables: [],
  },

  'corner-lifecycle.the-fallback-reviewer-command-could-not-be-queued': {
    parts: ['the fallback reviewer command could not be queued', ''],
    variables: ['queued_error_queued_error'],
  },

  'corner-lifecycle.merge-refused': {
    parts: ['merge_refused'],
    variables: [],
  },

  'corner-lifecycle.refused-to-merge': {
    parts: ['refused to merge'],
    variables: [],
  },

  'corner-lifecycle.blocked-configured-reviewer-could-not-be-reached': {
    parts: ['blocked: configured reviewer ', ' could not be reached: ', ''],
    variables: ['input_reviewerName_input_reviewerId', 'input_reason'],
  },

  'corner-lifecycle.blocked-no-reviewer-on-the-configured-list-is-healthy-arrange-a-r': {
    parts: [
      'blocked: no reviewer on the configured list is healthy; arrange a reviewer or restore access',
    ],
    variables: [],
  },

  'corner-reviewer.set-the-corner-reviewer': {
    parts: ['set the corner reviewer'],
    variables: [],
  },

  'daemon-service.mcp-server': {
    parts: ['MCP server'],
    variables: [],
  },

  'daemon-service.this-repository': {
    parts: ['This repository'],
    variables: [],
  },

  'daemon-service.has-no-commits-yet-push-a-first-commit-and-i-ll-pick-it-up': {
    parts: ["has no commits yet - push a first commit and I'll pick it up."],
    variables: [],
  },

  'daemon-service.install-or-grant-the-beeline-github-app': {
    parts: ['Install or grant the Beeline GitHub App'],
    variables: [],
  },

  'daemon-service.to-access-this-repository': {
    parts: ['to access this repository.'],
    variables: [],
  },

  'daemon-service.wants-a-vault-entry': {
    parts: ['wants a vault entry'],
    variables: [],
  },

  'daemon-service.vault-entry-title': {
    parts: ['', ' / ', ''],
    variables: ['metadata_service', 'metadata_label'],
  },

  'daemon-service.passed-checks-on': {
    parts: ['passed checks on'],
    variables: [],
  },

  'daemon-service.this-zero-check-pull-request': {
    parts: ['this zero-check pull request'],
    variables: [],
  },

  'daemon-service.connected': {
    parts: ['connected'],
    variables: [],
  },

  'daemon-service.the-requesting-agent-can-continue-the-original-task': {
    parts: ['the requesting agent can continue the original task'],
    variables: [],
  },

  'daemon-service.needs': {
    parts: ['needs'],
    variables: [],
  },

  'daemon-service.provider-sign-in': {
    parts: ['provider sign-in'],
    variables: [],
  },

  'daemon-service.the-provider-sign-in-page-is-ready-connect-this-tool-through-trus': {
    parts: ['the provider sign-in page is ready · connect this tool through Trusty Squire'],
    variables: [],
  },

  'daemon-service.tailscale-sign-in': {
    parts: ['Tailscale sign-in'],
    variables: [],
  },

  'daemon-service.click-the-link-to-join-this-machine-to-the-tailnet': {
    parts: ['click the link to join this machine to the tailnet'],
    variables: [],
  },

  'daemon-service.closed': {
    parts: ['closed'],
    variables: [],
  },

  'daemon-service.link-purchase-at': {
    parts: ['Link purchase at ', ''],
    variables: ['input_merchant'],
  },

  'daemon-service.usd': {
    parts: ['', ' USD · ', ''],
    variables: ['input_amount_100_toFixed_2', 'input_description'],
  },

  'daemon-service.link': {
    parts: ['Link'],
    variables: [],
  },

  'daemon-service.needs-your-approval-for': {
    parts: ['needs your approval for'],
    variables: [],
  },

  'daemon-service.trusty-squire': {
    parts: ['trusty-squire'],
    variables: [],
  },

  'daemon-service.the-request-to': {
    parts: ['The request to ', ''],
    variables: ['action'],
  },

  'daemon-service.expired': {
    parts: ['expired'],
    variables: [],
  },

  'daemon-service.was-allowed': {
    parts: ['was allowed'],
    variables: [],
  },

  'daemon-service.was-denied': {
    parts: ['was denied'],
    variables: [],
  },

  'daemon-service.google-sign-in': {
    parts: ['Google sign-in'],
    variables: [],
  },

  'daemon-service.asked-to': {
    parts: ['asked ', ' to'],
    variables: ['requester_handle_requester_handle'],
  },

  'daemon-service.requester-mention': {
    parts: ['@', ''],
    variables: ['requester_handle'],
  },

  'daemon-service.an-agent': {
    parts: ['An agent'],
    variables: [],
  },

  'daemon-service.emitted': {
    parts: ['emitted'],
    variables: [],
  },

  'daemon-service.your-agent': {
    parts: ['Your agent'],
    variables: [],
  },

  'daemon-service.saved-its-avatar': {
    parts: ['saved its avatar'],
    variables: [],
  },

  'daemon-service.your-avatar-is-ready': {
    parts: ['Your avatar is ready.'],
    variables: [],
  },

  'daemon-service.needs-a-different-model': {
    parts: ['needs a different model'],
    variables: [],
  },

  'daemon-service.open-this-agent-s-settings-and-choose-an-available-model-or-effor': {
    parts: ['Open this agent’s settings and choose an available model or effort.'],
    variables: [],
  },

  'daemon-service.the-previous-model': {
    parts: ['The previous model'],
    variables: [],
  },

  'daemon-service.the-default-model': {
    parts: ['the default model'],
    variables: [],
  },

  'daemon-service.switched-models': {
    parts: ['switched models'],
    variables: [],
  },

  'daemon-service.is-no-longer-offered-now-using': {
    parts: ['', ' is no longer offered; now using ', '.'],
    variables: ['oldModelName', 'newModelName'],
  },

  'daemon-service.proposed-a-target-branch': {
    parts: ['proposed a target branch'],
    variables: [],
  },

  'daemon-service.instead-of': {
    parts: ['instead of ', ''],
    variables: ['input_from'],
  },
} as const;
