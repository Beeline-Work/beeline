/** Owner-approved System wording. Writers supply data to these templates by key.
 * Wording changes and new keys require the owner's approval; code refactors do not.
 * variables describe the ordered slots; parts preserve every byte around them.
 */
export const SYSTEM_MESSAGE_CATALOG = {
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
  'daemon-service.needs-a-connection-to': {
    parts: ['needs a connection to'],
    variables: [],
  },
  'daemon-service.sign-in-to-continue-the-request': {
    parts: ['Sign in to continue the request.'],
    variables: [],
  },
  'daemon-service.complete-this-sign-in-to-connect-the-tool': {
    parts: ['complete this sign-in to connect the tool'],
    variables: [],
  },
  'daemon-service.space': {
    parts: [' '],
    variables: [],
  },
  'daemon-service.asked-to-switch': {
    parts: ['asked ', ' to switch'],
    variables: ['addresseeMention'],
  },
  'daemon-service.offered': {
    parts: ['offered ', ''],
    variables: ['addresseeMention'],
  },
  'daemon-service.s-google-account': {
    parts: ['', "'s Google account"],
    variables: ['connectorName'],
  },
  'daemon-service.opened-a-corner': {
    parts: ['opened a corner'],
    variables: [],
  },
  'daemon-service.revised-the-corner-brief': {
    parts: ['revised the corner brief'],
    variables: [],
  },
  'daemon-service.revision': {
    parts: ['Revision ', ''],
    variables: ['revision'],
  },
  'daemon-service.agent': {
    parts: ['Agent ', ''],
    variables: ['agentId_slice_0_8'],
  },
  'daemon-service.wants-to-connect': {
    parts: ['wants to connect'],
    variables: [],
  },
  'daemon-service.and': {
    parts: [' and '],
    variables: [],
  },
  'daemon-service.wants': {
    parts: ['wants'],
    variables: [],
  },
  'daemon-service.to-connect': {
    parts: ['', ' to connect ', ''],
    variables: ['agent_name', 'connectionInstallName_grant'],
  },
  'daemon-service.to': {
    parts: ['', ' to ', ' ', ''],
    variables: ['agent_name', 'grant_kind_path_read_grant', 'grant_target'],
  },
  'daemon-service.read': {
    parts: ['read'],
    variables: [],
  },
  'daemon-service.write': {
    parts: ['write'],
    variables: [],
  },
  'daemon-service.isolate': {
    parts: ['isolate'],
    variables: [],
  },
  'daemon-service.use': {
    parts: ['use'],
    variables: [],
  },
  'feedback.https-github-com-pull': {
    parts: ['https://github.com/', '/pull/', ''],
    variables: ['config_repository', 'number'],
  },
  'feedback.fixed': {
    parts: ['Fixed: ', ' ', ''],
    variables: ['title', 'url'],
  },
  'first-party-integrations.a-member': {
    parts: ['A member'],
    variables: [],
  },
  'first-party-integrations.connected': {
    parts: ['connected'],
    variables: [],
  },
  'first-party-integrations.the-request-can-continue': {
    parts: ['The request can continue.'],
    variables: [],
  },
  'free-agent-turn-close.ran-out-of-free-allowance-mid-task': {
    parts: ['ran out of free allowance mid-task'],
    variables: [],
  },
  'free-agent-turn-close.hit-the-15-minute-limit': {
    parts: ['hit the 15-minute limit'],
    variables: [],
  },
  'free-agent-turn-close.ended-without-a-reply': {
    parts: ['ended without a reply'],
    variables: [],
  },
  'free-agent-turn-close.stopped-after-a-runtime-failure': {
    parts: ['stopped after a runtime failure'],
    variables: [],
  },
  'free-agent-turn-close.stopped-before-replying': {
    parts: ['stopped before replying'],
    variables: [],
  },
  'free-agent-turn-close.connect-your-own-agent-from-members-to-continue': {
    parts: ['connect your own agent from Members to continue'],
    variables: [],
  },
  'free-agent-turn-close.it-resets-at-midnight-utc-ask-to-continue-then': {
    parts: ['it resets at midnight UTC; ask to continue then'],
    variables: [],
  },
  'free-agent-turn-close.say-continue-to-pick-up-where-work-stopped': {
    parts: ['say "continue" to pick up where work stopped'],
    variables: [],
  },
  'free-agents.could-not-start': {
    parts: ['could not start'],
    variables: [],
  },
  'free-agents.for': {
    parts: ['for @', ''],
    variables: ['target_person_handle'],
  },
  'free-agents.the-beeline-team-has-been-told-send-a-new-message-to-try-again': {
    parts: ['the Beeline team has been told. Send a new message to try again'],
    variables: [],
  },
  'github-operations.pull-request': {
    parts: ['pull_request'],
    variables: [],
  },
  'github-operations.check-run': {
    parts: ['check_run'],
    variables: [],
  },
  'github-operations.found-merge-conflicts-in': {
    parts: ['found merge conflicts in'],
    variables: [],
  },
  'github-operations.pull-request-2': {
    parts: ['pull request #', ''],
    variables: ['row_number'],
  },
  'github-operations.github': {
    parts: ['github'],
    variables: [],
  },
  'github-operations.merged': {
    parts: ['merged'],
    variables: [],
  },
  'github-operations.pull-request-3': {
    parts: ['Pull request #', ''],
    variables: ['integer_pullRequest_number'],
  },
  'github-operations.opened-a-pull-request': {
    parts: ['opened a pull request'],
    variables: [],
  },
  'github-operations.pushed': {
    parts: ['pushed'],
    variables: [],
  },
  'github-operations.commit-to': {
    parts: ['', ' commit', ' to '],
    variables: ['commits', 'commits_1_s'],
  },
  'github-operations.s': {
    parts: ['s'],
    variables: [],
  },
  'github-operations.at': {
    parts: ['at ', ''],
    variables: ['head_slice_0_12'],
  },
  'github-operations.passed': {
    parts: ['passed'],
    variables: [],
  },
  'github-operations.started': {
    parts: ['started'],
    variables: [],
  },
  'github-operations.cancelled': {
    parts: ['cancelled'],
    variables: [],
  },
  'github-operations.found-failing-checks-on': {
    parts: ['found failing checks on'],
    variables: [],
  },
  'github-operations.a-check': {
    parts: ['', ' a check'],
    variables: ['label'],
  },
  'github-operations.the-pull-request': {
    parts: ['the pull request'],
    variables: [],
  },
  'github-operations.failing': {
    parts: ['failing ', ''],
    variables: ['failing_join'],
  },
  'github-operations.list-separator': {
    parts: [', '],
    variables: [],
  },
  'grant-policy-upgrade.system': {
    parts: ['@system'],
    variables: [],
  },
  'grant-policy-upgrade.revoked-a-legacy-grant-for': {
    parts: ['revoked a legacy grant for'],
    variables: [],
  },
  'grant-policy-upgrade.grant-target': {
    parts: ['', ' ', ''],
    variables: ['grant_kind', 'grant_target'],
  },
  'grant-policy-upgrade.permission-policy-upgraded': {
    parts: ['permission policy upgraded'],
    variables: [],
  },
  'membership-join.joined': {
    parts: ['joined'],
    variables: [],
  },
  'membership-join.invited-by': {
    parts: ['invited by'],
    variables: [],
  },
  'corner-names.separator': {
    parts: ['-'],
    variables: [],
  },
  'corner-names.corner': {
    parts: ['corner-', ''],
    variables: ['corner_id_slice_0_8'],
  },
  'corner-names.suffixed-name': {
    parts: ['', '-', ''],
    variables: ['base', 'suffix'],
  },
  'workflow-cleanup.abandoned': {
    parts: ['abandoned'],
    variables: [],
  },
  'phone-service.message-deleted': {
    parts: ['Message deleted'],
    variables: [],
  },
  'phone-service.could-not-be-reached': {
    parts: ['could not be reached'],
    variables: [],
  },
  'phone-service.not-a-member-of-this-corner': {
    parts: ['not a member of this corner'],
    variables: [],
  },
  'phone-service.did-not-answer': {
    parts: ['did not answer'],
    variables: [],
  },
  'phone-service.only-may-address-ask-the-user-for-permission-to-access-the-agent': {
    parts: [
      'only ',
      ' may address ',
      '. Ask the user for permission to access the agent in the members page',
    ],
    variables: ['personMention_agent_owner_handle_the', 'agentMention'],
  },
  'phone-service.the-owner': {
    parts: ['the owner'],
    variables: [],
  },
  'phone-service.its-helper-is-offline': {
    parts: ['its helper is offline'],
    variables: [],
  },
  'phone-service.stopped': {
    parts: ['stopped'],
    variables: [],
  },
  'phone-service.turn-cancelled': {
    parts: ['turn cancelled', ''],
    variables: ['dropped_dropped_queued_dropped_1'],
  },
  'phone-service.queued-dropped': {
    parts: [' · ', ' queued ', ' dropped'],
    variables: ['dropped', 'dropped_1_order_orders'],
  },
  'phone-service.order': {
    parts: ['order'],
    variables: [],
  },
  'phone-service.orders': {
    parts: ['orders'],
    variables: [],
  },
  'phone-service.declined': {
    parts: ['declined'],
    variables: [],
  },
  'phone-service.edit-files': {
    parts: ['edit files'],
    variables: [],
  },
  'phone-service.allowed': {
    parts: ['allowed'],
    variables: [],
  },
  'phone-service.denied': {
    parts: ['denied'],
    variables: [],
  },
  'phone-service.to': {
    parts: ['', ' to ', ''],
    variables: ['systemIdentityMention_id_agent_pubkey_kind', 'tool'],
  },
  'phone-service.opened-a-corner': {
    parts: ['opened a corner'],
    variables: [],
  },
  'phone-service.changed-room-visibility-to': {
    parts: ['changed room visibility to'],
    variables: [],
  },
  'phone-service.left': {
    parts: ['left'],
    variables: [],
  },
  'phone-service.removed': {
    parts: ['removed'],
    variables: [],
  },
  'phone-service.approved': {
    parts: ['approved'],
    variables: [],
  },
  'phone-service.approved-once': {
    parts: ['approved once'],
    variables: [],
  },
  'phone-service.grant-target': {
    parts: ['', ' ', ''],
    variables: ['grant_kind', 'grant_target'],
  },
  'phone-service.turned-yolo-on-for': {
    parts: ['turned yolo on for'],
    variables: [],
  },
  'phone-service.turned-yolo-off-for': {
    parts: ['turned yolo off for'],
    variables: [],
  },
  'phone-service.grant-requests-are-now-approved-automatically': {
    parts: ['grant requests are now approved automatically'],
    variables: [],
  },
  'phone-service.grant-requests-now-ask-before-running': {
    parts: ['grant requests now ask before running'],
    variables: [],
  },
  'phone-service.a-member': {
    parts: ['A member'],
    variables: [],
  },
  'phone-service.connected': {
    parts: ['connected'],
    variables: [],
  },
  'phone-service.the-request-can-continue': {
    parts: ['The request can continue.'],
    variables: [],
  },
  'phone-service.person-mention': {
    parts: ['@', ''],
    variables: ['trimmed'],
  },
  'provider-webhooks.beeline': {
    parts: ['Beeline'],
    variables: [],
  },
  'provider-webhooks.received': {
    parts: ['received'],
    variables: [],
  },
  'provider-webhooks.a-linear-issue': {
    parts: ['a Linear issue'],
    variables: [],
  },
  'provider-webhooks.a-stripe-payment': {
    parts: ['a Stripe payment'],
    variables: [],
  },
  'repository-onboarding.suggested-work': {
    parts: ['suggested work'],
    variables: [],
  },
  'repository-onboarding.offered-a-repository': {
    parts: ['offered a repository'],
    variables: [],
  },
  'repository-onboarding.choose-or-create-a-repository': {
    parts: ['Choose or create a repository'],
    variables: [],
  },
  'repository-subscription-line.opened-issue': {
    parts: ['opened issue'],
    variables: [],
  },
  'repository-subscription-line.closed-issue': {
    parts: ['closed issue'],
    variables: [],
  },
  'repository-subscription-line.reopened-issue': {
    parts: ['reopened issue'],
    variables: [],
  },
  'repository-subscription-line.opened-pull-request': {
    parts: ['opened pull request'],
    variables: [],
  },
  'repository-subscription-line.merged-pull-request': {
    parts: ['merged pull request'],
    variables: [],
  },
  'repository-subscription-line.closed-pull-request': {
    parts: ['closed pull request'],
    variables: [],
  },
  'repository-subscription-line.reopened-pull-request': {
    parts: ['reopened pull request'],
    variables: [],
  },
  'repository-subscription-line.starred': {
    parts: ['starred'],
    variables: [],
  },
  'repository-subscription-line.unstarred': {
    parts: ['unstarred'],
    variables: [],
  },
  'repository-subscription-line.space': {
    parts: [' '],
    variables: [],
  },
  'repository-subscription-line.clipped-title': {
    parts: ['', '…'],
    variables: ['title_slice_0_79_trimEnd'],
  },
  'repository-subscription-line.item-number': {
    parts: ['#', ''],
    variables: ['details_number'],
  },
  'repository-subscription-line.github': {
    parts: ['GitHub'],
    variables: [],
  },
  'room-choice.asked': {
    parts: ['asked'],
    variables: [],
  },
  'room-choice.of-voted-for': {
    parts: ['', ' of ', ' voted for ', ''],
    variables: ['responses_length', 'choice_electorate_length', 'winner_label'],
  },
  'room-choice.asked-a-poll': {
    parts: ['asked a poll'],
    variables: [],
  },
  'room-choice.expired-no-answer': {
    parts: ['expired · no answer'],
    variables: [],
  },
  'room-choice.skipped': {
    parts: ['skipped · @', ''],
    variables: ['handleOf_viewer'],
  },
  'room-choice.skipped-2': {
    parts: ['skipped'],
    variables: [],
  },
  'room-choice.someone': {
    parts: ['someone'],
    variables: [],
  },
  'room-choice.picked': {
    parts: ['picked ', ' · @', ''],
    variables: ['option_letter', 'handleOf_viewer'],
  },
  'room-choice.picked-2': {
    parts: ['picked'],
    variables: [],
  },
  'starter-onboarding.make-a-welcome-video-and-post-it-to-my-youtube': {
    parts: ['Make a welcome video and post it to my YouTube'],
    variables: [],
  },
  'starter-onboarding.beebee-makes-it-luna-checks-it-you-approve-the-post': {
    parts: ['Beebee makes it, Luna checks it, you approve the post'],
    variables: [],
  },
  'starter-onboarding.play-tic-tac-toe-with-me': {
    parts: ['Play tic-tac-toe with me'],
    variables: [],
  },
  'starter-onboarding.you-and-beebee-against-luna': {
    parts: ['You and Beebee against Luna'],
    variables: [],
  },
  'starter-onboarding.something-else': {
    parts: ['Something else'],
    variables: [],
  },
  'starter-onboarding.tell-us-the-job-in-your-own-words': {
    parts: ['Tell us the job in your own words'],
    variables: [],
  },
  'starter-onboarding.pick-a-first-job': {
    parts: ['Pick a first job'],
    variables: [],
  },
  'starter-onboarding.visibility': {
    parts: ['Visibility: ', ''],
    variables: ['input_visibility'],
  },
  'starter-onboarding.post': {
    parts: ['Post'],
    variables: [],
  },
  'starter-onboarding.cancel': {
    parts: ['Cancel'],
    variables: [],
  },
  'starter-onboarding.after-your-game-what-next': {
    parts: ['After your game, what next?'],
    variables: [],
  },
  'starter-onboarding.invite-a-friend-to-play': {
    parts: ['Invite a friend to play'],
    variables: [],
  },
  'starter-onboarding.give-us-a-real-task': {
    parts: ['Give us a real task'],
    variables: [],
  },
  'startup-wake-backoff.keeps-failing-to-start-automatic-wakes-are-paused-for-5-minutes': {
    parts: ['', ' keeps failing to start. Automatic wakes are paused for 5 minutes.'],
    variables: ['owner_name'],
  },
  'subscription-webhooks.beeline': {
    parts: ['Beeline'],
    variables: [],
  },
  'subscription-webhooks.received': {
    parts: ['received'],
    variables: [],
  },
  'subscription-webhooks.a-webhook-call': {
    parts: ['a webhook call'],
    variables: [],
  },
  'system-line.space': {
    parts: [' '],
    variables: [],
  },
  'system-line.handle-word-separator': {
    parts: ['_'],
    variables: [],
  },
  'system-line.agent': {
    parts: ['agent'],
    variables: [],
  },
  'system-line.identity-mention': {
    parts: ['@', ''],
    variables: ['row_handle'],
  },
  'system-line.github': {
    parts: ['GitHub'],
    variables: [],
  },
  'system-line.beeline': {
    parts: ['Beeline'],
    variables: [],
  },
  'system-line.received': {
    parts: ['received'],
    variables: [],
  },
  'system-line.a-room-event': {
    parts: ['a Room event'],
    variables: [],
  },
  'turn-silence-notice.space': {
    parts: [' '],
    variables: [],
  },
  'turn-silence-notice.failed': {
    parts: ['failed: ', ' (', '): ', ''],
    variables: ['place_name', 'input_roomId', 'reason_classified_fault_agent_turn'],
  },
  'turn-silence-notice.agent-turn-failed': {
    parts: ['agent turn failed'],
    variables: [],
  },
  'unfinished-app-sign-ins.app-sign-in-timed-out-open-the-connection-card-and-sign-in-again': {
    parts: ['App sign-in timed out. Open the connection card and sign in again.'],
    variables: [],
  },
  'vault-save-http.saved-a-vault-entry': {
    parts: ['saved a vault entry'],
    variables: [],
  },
  'vault-save-http.entry-title': {
    parts: ['', ' / ', ''],
    variables: ['metadata_service', 'metadata_label'],
  },
  'vault-save-http.fields-hosts': {
    parts: ['', ' · fields: ', ' · hosts: ', ''],
    variables: [
      'result_reference',
      'metadata_fields_map_field_field',
      'result_allowedHosts_metadata_allowedHosts_join',
    ],
  },
  'vault-save-http.list-separator': {
    parts: [', '],
    variables: [],
  },
  'voice-service.voice-call': {
    parts: ['Voice call'],
    variables: [],
  },
  'voice-service.started': {
    parts: ['started'],
    variables: [],
  },
  'voice-service.call': {
    parts: ['Call'],
    variables: [],
  },
  'voice-service.ended': {
    parts: ['ended'],
    variables: [],
  },
  'voice-service.no-one-spoke-for-60s': {
    parts: [' · No one spoke for 60s'],
    variables: [],
  },
  'voice-service.separator': {
    parts: [' · ', ''],
    variables: ['row_end_reason'],
  },
  'voice-service.silence': {
    parts: ['silence'],
    variables: [],
  },
  'wallet-notices.detail-separator': {
    parts: ['; '],
    variables: [],
  },
  'wallet-notices.could-not-complete': {
    parts: ['could not complete'],
    variables: [],
  },
  'wallet-notices.confirmed': {
    parts: ['confirmed'],
    variables: [],
  },
  'wallet-notices.submitted': {
    parts: ['submitted'],
    variables: [],
  },
  'wallet-notices.you': {
    parts: ['you'],
    variables: [],
  },
  'wallet-notices.initiator-not-known-to-beeline': {
    parts: ['initiator not known to Beeline'],
    variables: [],
  },
  'wallet-notices.wallet': {
    parts: ['Wallet'],
    variables: [],
  },
  'wallet-notices.on': {
    parts: ['', ' ', ' on ', ' · ', ''],
    variables: ['next_operation', 'next_amountText', 'next_chain', 'next_counterparty'],
  },
  'wallet-notices.confirmation-pending': {
    parts: ['confirmation pending'],
    variables: [],
  },
  'wallet-notices.left': {
    parts: ['', ' left'],
    variables: ['next_balanceAfterUsd'],
  },
  'wallet-notices.separator': {
    parts: [' · '],
    variables: [],
  },
  'wallet.wallet': {
    parts: ['Wallet'],
    variables: [],
  },
  'wallet.granted': {
    parts: ['granted'],
    variables: [],
  },
  'wallet.agents-permission-to-sign': {
    parts: ['agents permission to sign'],
    variables: [],
  },
  'wallet.until-revoked': {
    parts: ['until revoked'],
    variables: [],
  },
  'wallet.agent-mention': {
    parts: ['@', ''],
    variables: ['row_handle'],
  },
  'wallet.signed': {
    parts: ['signed'],
    variables: [],
  },
  'wallet.eip-712-typed-data': {
    parts: ['EIP-712 typed data'],
    variables: [],
  },
  'wallet.an-agent': {
    parts: ['An agent'],
    variables: [],
  },
  'workbench.link': {
    parts: ['Link'],
    variables: [],
  },
  'workbench.mcp-connector': {
    parts: ['MCP Connector'],
    variables: [],
  },
  'workbench.b': {
    parts: ['', ' B'],
    variables: ['bytes'],
  },
  'workbench.kb': {
    parts: ['', ' kB'],
    variables: ['bytes_1024_toFixed_1'],
  },
  'workbench.mb': {
    parts: ['', ' MB'],
    variables: ['bytes_1024_1024_toFixed_1'],
  },
  'workbench.calls': {
    parts: ['', ' calls · ', ''],
    variables: ['records_length', 'formatBytes_totalBytes'],
  },
  'workbench.grant': {
    parts: ['grant ', ''],
    variables: ['records_0_grantLabel_records_0'],
  },
  'workbench.separator': {
    parts: [' · '],
    variables: [],
  },
  'workbench.agent': {
    parts: ['agent'],
    variables: [],
  },
  'workbench.used': {
    parts: ['used'],
    variables: [],
  },
  'workflow-runs.offline': {
    parts: ['offline'],
    variables: [],
  },
  'workflow-runs.recent-failure': {
    parts: ['recent failure'],
    variables: [],
  },
  'workflow-runs.out-of-credit': {
    parts: ['out of credit'],
    variables: [],
  },
  'workflow-runs.not-in-this-room': {
    parts: ['not in this Room'],
    variables: [],
  },
  'workflow-runs.earlier-on-the-list': {
    parts: ['earlier on the list'],
    variables: [],
  },
  'workflow-runs.eligible': {
    parts: ['eligible'],
    variables: [],
  },
  'workflow-runs.agent-health': {
    parts: ['', ' ', ''],
    variables: ['names_get_id', 'why'],
  },
  'workflow-runs.list-separator': {
    parts: [', '],
    variables: [],
  },
  'workflow-runs.no-agent-on-the-role-s-list': {
    parts: ['No agent on the ', " role's list"],
    variables: ['input_role'],
  },
  'workflow-runs.is-healthy': {
    parts: ['is healthy'],
    variables: [],
  },
  'workflow-runs.ask-an-agent-to-call-assign-workflow-role-to-bind-another-agent-i': {
    parts: ['', 'ask an agent to call assign_workflow_role to bind another agent in this Room'],
    variables: ['reasons_reasons_in_run_shortRunId'],
  },
  'workflow-runs.in-run': {
    parts: ['', ' in run ', '; '],
    variables: ['reasons', 'shortRunId_input_runId'],
  },
  'workflow-runs.in-run-2': {
    parts: ['in run ', '; '],
    variables: ['shortRunId_input_runId'],
  },
  'workflow-runs.h': {
    parts: ['', ' h'],
    variables: ['seconds_3600'],
  },
  'workflow-runs.min': {
    parts: ['', ' min'],
    variables: ['seconds_60'],
  },
  'workflow-runs.s': {
    parts: ['', ' s'],
    variables: ['seconds'],
  },
  'workflow-runs.space': {
    parts: [' '],
    variables: [],
  },
  'workflow-runs.choose-the-next-step-for': {
    parts: ['Choose the next step for ', ''],
    variables: ['input_contract_name_replace_g'],
  },
  'workflow-runs.no-answer-in-applies': {
    parts: ['No answer in ', ' applies ', ''],
    variables: ['durationText_input_state_timeoutSeconds', 'input_state_default'],
  },
  'workflow-runs.continue-to': {
    parts: ['Continue to ', ''],
    variables: ['target_replace_g'],
  },
  'workflow-runs.the-workflow': {
    parts: ['the workflow'],
    variables: [],
  },
  'workflow-runs.moved': {
    parts: ['moved'],
    variables: [],
  },
  'workflow-runs.to-because-in-run-of': {
    parts: ['', 'to ', ' because ', ' in run ', ' of ', ''],
    variables: [
      'from_from_names_get_from',
      'names_get_input_picked',
      'input_why',
      'shortRunId_runId',
      'run_workflowSlug',
    ],
  },
  'workflow-runs.from': {
    parts: ['from ', ' '],
    variables: ['names_get_from'],
  },
  'workflow-runs.applied': {
    parts: ['applied'],
    variables: [],
  },
  'workflow-runs.timeout': {
    parts: ['timeout'],
    variables: [],
  },
  'workflow-runs.at-and-went-to-because-nobody-on-the-role-is-left-in-run-of': {
    parts: [
      'at ',
      ' and went to ',
      ' because nobody on the ',
      ' role is left',
      ' in run ',
      ' of ',
      '',
    ],
    variables: [
      'scope_stateName',
      'toState',
      'role',
      'reasons_reasons',
      'shortRunId_scope_runId',
      'scope_run_workflowSlug',
    ],
  },
  'workflow-runs.health-reasons': {
    parts: [' (', ')'],
    variables: ['reasons'],
  },
  'workflow-runs.cancelled-workflow': {
    parts: ['cancelled workflow'],
    variables: [],
  },
  'workflow-runs.run': {
    parts: ['run ', ''],
    variables: ['shortRunId_input_runId'],
  },
  'workflow-runs.handed-off': {
    parts: ['handed off'],
    variables: [],
  },
  'workflow-runs.run-of': {
    parts: ['run ', ' of ', ''],
    variables: ['shortRunId_input_runId', 'run_workflowSlug'],
  },
  'workflow-runs.skipped': {
    parts: ['skipped'],
    variables: [],
  },
  'workflow-runs.answered': {
    parts: ['answered'],
    variables: [],
  },
  'workflow-runs.picked': {
    parts: ['picked'],
    variables: [],
  },
  'workflow-runs.so-applied-and-run-went-to': {
    parts: ['so ', ' applied and run ', ' went to ', ''],
    variables: ['label', 'shortRunId_scope_runId', 'toState'],
  },
  'workflow-runs.by-message-at-so-run-went-to': {
    parts: ['by message at ', ' so run ', ' went to ', ''],
    variables: ['scope_stateName', 'shortRunId_scope_runId', 'toState'],
  },
  'workflow-runs.at-so-run-went-to': {
    parts: ['at ', ' so run ', ' went to ', ''],
    variables: ['scope_stateName', 'shortRunId_scope_runId', 'toState'],
  },
  'workflow-runs.the-gate-of': {
    parts: ['The ', ' gate of ', ''],
    variables: ['scope_stateName', 'scope_run_workflowSlug'],
  },
  'workflow-runs.took-its-default': {
    parts: ['took its default'],
    variables: [],
  },
  'workflow-runs.skipped-it-in-run': {
    parts: ['', ' skipped it in run ', ''],
    variables: ['systemIdentityMention_viewer_handle_viewer_handle', 'shortRunId_scope_runId'],
  },
  'workflow-runs.at-and-went-to-because-nobody-answered-in-in-run-of': {
    parts: ['at ', ' and went to ', ' because nobody answered in ', ' in run ', ' of ', ''],
    variables: [
      'scope_stateName',
      'toState',
      'after',
      'shortRunId_scope_runId',
      'scope_run_workflowSlug',
    ],
  },
  'workflow-runs.nobody-answered-in-in-run': {
    parts: ['nobody answered in ', ' in run ', ''],
    variables: ['after', 'shortRunId_scope_runId'],
  },
  'workflow-runs.of': {
    parts: [' of ', ''],
    variables: ['durationText_seconds'],
  },
  'workflow-runs.closed': {
    parts: ['closed'],
    variables: [],
  },
  'workflow-runs.as-failed-at-because-it-passed-its-deadline': {
    parts: ['as failed at ', ' because it passed its deadline', ''],
    variables: ['scope_stateName', 'after'],
  },
  'workflow-runs.as-abandoned-at-because-its-corner-closed': {
    parts: ['as abandoned at ', ' because its corner closed'],
    variables: ['scope_stateName'],
  },
  'workflow-runs.unknown': {
    parts: ['unknown'],
    variables: [],
  },
  'workflow-runs.live': {
    parts: ['live'],
    variables: [],
  },
  'workflow-runs.started-workflow': {
    parts: ['started workflow'],
    variables: [],
  },
  'agent-grants.github': {
    parts: ['GitHub'],
    variables: [],
  },
  'agent-grants.this-app': {
    parts: ['this app'],
    variables: [],
  },
  'agent-sign-in.claude': {
    parts: ['Claude'],
    variables: [],
  },
  'agent-sign-in.chatgpt': {
    parts: ['ChatGPT'],
    variables: [],
  },
  'agent-sign-in.grok': {
    parts: ['Grok'],
    variables: [],
  },
  'agent-sign-in.cursor': {
    parts: ['Cursor'],
    variables: [],
  },
  'agent-sign-in.its-provider': {
    parts: ['its provider'],
    variables: [],
  },
  'approval-copy.reveal-a-key': {
    parts: ['reveal a key'],
    variables: [],
  },
  'approval-copy.buy': {
    parts: ['buy ', ''],
    variables: ['first_an_item'],
  },
  'approval-copy.an-item': {
    parts: ['an item'],
    variables: [],
  },
  'approval-copy.edit-a-key': {
    parts: ['edit a key'],
    variables: [],
  },
  'approval-copy.delete-a-key': {
    parts: ['delete a key'],
    variables: [],
  },
  'approval-copy.edit-a-card': {
    parts: ['edit a card'],
    variables: [],
  },
  'approval-copy.sign-in-to': {
    parts: ['sign in to ', ''],
    variables: ['first_replace_Sign_in_to'],
  },
  'approval-copy.a-site': {
    parts: ['a site'],
    variables: [],
  },
  'approval-copy.confirm-a-purchase': {
    parts: ['confirm a purchase'],
    variables: [],
  },
  'approval-copy.request-a-vouch': {
    parts: ['request a vouch'],
    variables: [],
  },
  'approval-copy.use-a-passkey': {
    parts: ['use a passkey'],
    variables: [],
  },
  'approval-copy.use-trusty-squire': {
    parts: ['use Trusty Squire'],
    variables: [],
  },
  'connector-offers.still-no-raw-key-in-chat': {
    parts: ['still no raw key in chat'],
    variables: [],
  },
  'connector-offers.this-changes-your-connectors-once-it-is-added-i-can': {
    parts: ['This changes your Connectors. Once it is added, I can ', ' — ', ''],
    variables: ['clause', 'boundary'],
  },
  'connector-offers.this-changes-your-connectors-once-it-is-added-i-can-sign-up-and-s': {
    parts: [
      'This changes your Connectors. Once it is added, I can sign up and sign in to websites for you and use keys its vault holds — ',
      '',
    ],
    variables: ['CONNECTOR_OFFER_KEY_BOUNDARY'],
  },
  'connector-offers.this-changes-your-connectors-once-it-is-added-you-sign-in-to-goog': {
    parts: [
      'This changes your Connectors. Once it is added, you sign in to Google yourself and I work through that sign-in — I never see your password',
    ],
    variables: [],
  },
  'connector-offers.this-changes-your-connectors-once-it-is-added-i-can-pay-from-your': {
    parts: ['This changes your Connectors. Once it is added, I can pay from your wallet — ', ''],
    variables: ['boundary'],
  },
  'connector-offers.this-changes-your-connectors-once-it-is-added-i-can-use-the-tool': {
    parts: ['This changes your Connectors. Once it is added, I can use the tool from there — ', ''],
    variables: ['boundary'],
  },
  'connector-offers.sign-in-to-google-once-so-trusty-squire-can-sign-in-to-websites-a': {
    parts: [
      'Sign in to Google once, so Trusty Squire can sign in to websites and APIs for you hands-free.',
    ],
    variables: [],
  },
  'connector-offers.you-ll-sign-in-to-google-again-with-the-account-trusty-squire-sho': {
    parts: [
      "You'll sign in to Google again, with the account Trusty Squire should use. The account signed in now is replaced for every task on this machine.",
    ],
    variables: [],
  },
  'connector-offers.then-i-can': {
    parts: ['', ' Then I can ', ''],
    variables: ['line', 'clause'],
  },
  'connector-offers.i-never-see-your-password': {
    parts: ['I never see your password'],
    variables: [],
  },
  'connector-offers.you-can-revoke-permission-any-time': {
    parts: ['you can revoke permission any time'],
    variables: [],
  },
  'connector-offers.its-credentials-stay-in-the-tool-never-in-chat': {
    parts: ['its credentials stay in the tool, never in chat'],
    variables: [],
  },
  'room-choices.space': {
    parts: [' '],
    variables: [],
  },
  'room-choices.closed-no-votes': {
    parts: ['closed · no votes'],
    variables: [],
  },
  'room-choices.tied': {
    parts: ['tied · ', ''],
    variables: ['tied_join_and'],
  },
  'room-choices.and': {
    parts: [' and '],
    variables: [],
  },
  'room-choices.closed-of-voted': {
    parts: ['closed · ', ' of ', ' voted'],
    variables: ['votedCount', 'electorateCount'],
  },
  'scheduled-prompts.beeline-scheduler': {
    parts: ['Beeline Scheduler'],
    variables: [],
  },
  'scheduled-prompts.ran-a-schedule-for': {
    parts: ['ran a schedule for'],
    variables: [],
  },
  'system-events.separator': {
    parts: [' · '],
    variables: [],
  },
  'system-events.and': {
    parts: ['', ' and ', ''],
    variables: ['names_slice_0_1_join', 'names_names_length_1'],
  },
  'system-events.list-separator': {
    parts: [', '],
    variables: [],
  },
  'system-events.space': {
    parts: [' '],
    variables: [],
  },
  'system-events.with-object': {
    parts: ['', ' ', ''],
    variables: ['head', 'event_object_text'],
  },
  'turn-silence.its-provider-is-failing-switch-its-model-in-the-agent-s-settings': {
    parts: ["its provider is failing; switch its model in the agent's settings."],
    variables: [],
  },
  'turn-silence.node': {
    parts: ['Node'],
    variables: [],
  },
  'turn-silence.its-interpreter': {
    parts: ['its interpreter'],
    variables: [],
  },
  'turn-silence.it-couldn-t-start-the-background-service-can-t-find-install-on-th': {
    parts: [
      "it couldn't start: the background service can't find ",
      '. Install ',
      ' on this computer, then run `beeline connect`',
    ],
    variables: ['dependency', 'dependency_Node_Node_the_required'],
  },
  'turn-silence.the-required-interpreter': {
    parts: ['the required interpreter'],
    variables: [],
  },
  'turn-silence.it-couldn-t-start-its-program-or-interpreter-is-missing-reinstall': {
    parts: [
      "it couldn't start: its program or interpreter is missing. Reinstall the agent on this computer with `beeline connect`",
    ],
    variables: [],
  },
  'turn-silence.the-turn-stalled': {
    parts: ['the turn stalled'],
    variables: [],
  },
  'turn-silence.the-repository': {
    parts: ['the repository'],
    variables: [],
  },
  'turn-silence.clipped-consequence': {
    parts: ['', '…'],
    variables: ['consequence_slice_0_Math_max'],
  },
  'turn-silence.could-not-answer': {
    parts: ['could not answer'],
    variables: [],
  },
  'turn-silence.the-selected-model-isn-t-available-pick-another-in-the-agent-s-se': {
    parts: ["the selected model isn't available. Pick another in the agent's settings."],
    variables: [],
  },
  'turn-silence.the-provider-allowance-is-spent-until-top-up-or-move-the-agent-to': {
    parts: [
      'the provider allowance is spent until ',
      '. Top up, or move the agent to another provider.',
    ],
    variables: ['until'],
  },
  'turn-silence.the-provider-allowance-is-spent-top-up-or-move-the-agent-to-anoth': {
    parts: ['the provider allowance is spent. Top up, or move the agent to another provider.'],
    variables: [],
  },
  'turn-silence.the-helper-could-not-authenticate-with-the-provider-check-its-log': {
    parts: [
      "the helper could not authenticate with the provider. Check its log for the failed turn; if its login expired, run `beeline connect` on the helper's machine.",
    ],
    variables: [],
  },
  'turn-silence.needs-a-new-provider-key': {
    parts: ['needs a new provider key'],
    variables: [],
  },
  'turn-silence.needs-a-sign-in': {
    parts: ['needs a ', ' sign-in'],
    variables: ['AGENT_SIGN_IN_SERVICE_LABELS'],
  },
  'turn-silence.send-login-here': {
    parts: ['send @', ' login here.'],
    variables: ['handle'],
  },
  'turn-silence.if-that-fails-its-owner-can-run-beeline-connect-on-its-machine': {
    parts: ['', ' If that fails, its owner can run `beeline connect` on its machine.'],
    variables: ['command'],
  },
  'turn-silence.the-helper-couldn-t-get-a-working-copy-of-check-the-repository-is': {
    parts: ["the helper couldn't get a working copy of ", '. Check the repository is reachable.'],
    variables: ['classified_repo_the_repository'],
  },
  'turn-silence.the-helper-is-out-of-date-run-beeline-start-on-the-helper-s-machi': {
    parts: ["the helper is out of date. Run `beeline start` on the helper's machine."],
    variables: [],
  },
  'turn-silence.was-interrupted-by-an-update': {
    parts: ['was interrupted by an update'],
    variables: [],
  },
  'turn-silence.the-request-is-queued-to-resume': {
    parts: ['the request is queued to resume.'],
    variables: [],
  },
  'turn-silence.is-offline': {
    parts: ['is offline'],
    variables: [],
  },
  'turn-silence.the-helper-is-unreachable-if-it-stays-offline-run-beeline-start-o': {
    parts: ['the helper is unreachable. If it stays offline, run `beeline start` on its machine.'],
    variables: [],
  },
  'turn-silence.the-request-no-longer-fits-the-model-s-context-window-start-a-new': {
    parts: [
      "the request no longer fits the model's context window. Start a new corner, or pick a model with a larger window.",
    ],
    variables: [],
  },
  'turn-silence.the-session-likely-hit-its-memory-limit-run-fewer-tools-at-once-o': {
    parts: ['the session likely hit its memory limit. Run fewer tools at once or split the task.'],
    variables: [],
  },
  'turn-silence.space': {
    parts: [' '],
    variables: [],
  },
  'turn-silence.is-waiting': {
    parts: ['is waiting'],
    variables: [],
  },
  'turn-silence.stopped-retrying-after-two-tries': {
    parts: ['Stopped retrying after two tries.'],
    variables: [],
  },
  'turn-silence.stopped-retrying-after-three-tries': {
    parts: ['Stopped retrying after three tries.'],
    variables: [],
  },
  'turn-silence.resending-your-message': {
    parts: ['Resending your message.'],
    variables: [],
  },
  'turn-silence.fault-and-remedy': {
    parts: ['', '. ', ''],
    variables: ['fault', 'remedy'],
  },
  'turn-silence.fault-sentence': {
    parts: ['', '.'],
    variables: ['fault'],
  },
  'turn-silence.provider-fault': {
    parts: ['', ' ', ''],
    variables: ['PROVIDER_OUTAGE_POINTER', 'detail'],
  },
  'voice.elapsed-time': {
    parts: ['', ':', ''],
    variables: ['Math_floor_elapsed_60', 'String_elapsed_60_padStart_2'],
  },
  'workflow-run-status.live': {
    parts: ['live'],
    variables: [],
  },
  'system-line.agent-name': {
    parts: ['The agent'],
    variables: [],
  },
  'daemon-service.retry-suffix': {
    parts: [' answered after a retry'],
    variables: [],
  },
  'daemon-service.answered-after-a-retry': {
    parts: ['answered after a retry'],
    variables: [],
  },
  'system-line.mention-prefix': {
    parts: ['@'],
    variables: [],
  },
  'system-line.deleted': {
    parts: ['deleted'],
    variables: [],
  },
  'system-line.a-message': {
    parts: ['a message'],
    variables: [],
  },
  'tray-approval-ask.approve': {
    parts: ['Approve ', '?'],
    variables: ['card_purpose_squire_spending_spending'],
  },
  'tray-approval-ask.spending-with': {
    parts: ['spending with '],
    variables: [],
  },
  'tray-approval-ask.write-access-to': {
    parts: ['write access to '],
    variables: [],
  },
  'tray-approval-ask.connect': {
    parts: ['Connect ', '?'],
    variables: ['field_connectorName'],
  },
  'tray-approval-ask.sign-in-to': {
    parts: ['Sign in to ', '?'],
    variables: ['field_name'],
  },
  'tray-approval-ask.approval-question': {
    parts: ['', ' ', '?'],
    variables: ['card_linkKind_passkey_Use_your', 'field_title'],
  },
  'tray-approval-ask.use-your-passkey-for': {
    parts: ['Use your passkey for'],
    variables: [],
  },
  'tray-approval-ask.vouch-for': {
    parts: ['Vouch for'],
    variables: [],
  },
  'tray-approval-ask.approve-2': {
    parts: ['Approve'],
    variables: [],
  },
  'tray-approval-ask.allow': {
    parts: ['Allow ', ' ', '?'],
    variables: ['grant_kind_command_running_access', 'grant_target'],
  },
  'tray-approval-ask.running': {
    parts: ['running'],
    variables: [],
  },
  'tray-approval-ask.access-to': {
    parts: ['access to'],
    variables: [],
  },
  'tray-ask.1': {
    parts: ['$1'],
    variables: [],
  },
  'tray-ask.1-2': {
    parts: ['$1$2'],
    variables: [],
  },
  'tray-ask.space': {
    parts: [' '],
    variables: [],
  },
  'tray-ask.clipped-ask': {
    parts: ['', '…'],
    variables: ['head_slice_0_boundary_100'],
  },
  'voice.0': {
    parts: ['0'],
    variables: [],
  },
  'voice-service.today-s-60-minutes-are-used': {
    parts: ["Today's 60 minutes are used"],
    variables: [],
  },
} as const;

export type SystemMessageKey = keyof typeof SYSTEM_MESSAGE_CATALOG;
type Catalog = typeof SYSTEM_MESSAGE_CATALOG;
type SlotValues<T extends readonly string[]> = { [I in keyof T]: unknown };
type Inputs<K extends SystemMessageKey> = SlotValues<Catalog[K]['variables']>;
type Output<K extends SystemMessageKey> = Catalog[K]['parts'] extends readonly [
  infer Text extends string,
]
  ? Text
  : string;

/** Interpolate with JavaScript template-literal coercion, preserving whitespace and punctuation. */
export function systemMessage<K extends SystemMessageKey>(key: K, ...values: Inputs<K>): Output<K> {
  const entry = SYSTEM_MESSAGE_CATALOG[key];
  if (values.length !== entry.variables.length)
    throw new Error(`System message ${key} needs ${entry.variables.length} variables`);
  let text: string = entry.parts[0];
  for (let index = 0; index < values.length; index++)
    text += `${values[index]}${entry.parts[index + 1]}`;
  return text as Output<K>;
}
