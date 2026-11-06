export const SYSTEM_MESSAGE_VOICE_SERVICE = {

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

  'wallet-notices.approval-confirmed-requires-new-action': {
    parts: ['Approval confirmed. The dependent transaction was not submitted; a new explicit action is required.'],
    variables: [],
  },

  'wallet-notices.could-not-confirm': { parts: ['could not confirm'], variables: [] },

  'wallet-notices.submission-outcome-unknown': { parts: ['submission outcome unknown'], variables: [] },

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
} as const;
