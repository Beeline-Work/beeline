export const SYSTEM_MESSAGE_TURN_SILENCE = {

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

  'connector-offer-completion.connector-setup': {
    parts: ['Connector setup'],
    variables: [],
  },

  'connector-offer-completion.failed': {
    parts: ['failed'],
    variables: [],
  },

  'connector-offer-completion.retry-the-connection-to-continue': {
    parts: ['Retry the connection to continue'],
    variables: [],
  },

  'free-agents.your-starter-agents': {
    parts: ['Your starter agents'],
    variables: [],
  },

  'free-agents.are-already-in': {
    parts: ['are already in'],
    variables: [],
  },

  'free-agents.could-not-be-added': {
    parts: ['could not be added'],
    variables: [],
  },

  'free-agents.starter-location': {
    parts: ['', ' in ', ''],
    variables: ['agent_name', 'agent_workspace_name'],
  },

  'free-agents.list-separator': {
    parts: [', '],
    variables: [],
  },

  'free-agents.your-account-has-reached-its-free-agent-limit': {
    parts: ['Your account has reached its free-agent limit'],
    variables: [],
  },
} as const;
