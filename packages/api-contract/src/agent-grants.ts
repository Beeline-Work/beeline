/**
 * Agent Grants (design note: "Agent Grants", 3 Sep 2026): the one shared
 * vocabulary for the grant loop. The server stores grants, the phone decides
 * them, and the daemon acts on them; every side imports these names so a kind,
 * a status, a decision line, or a command rule means exactly one thing.
 */

export const AGENT_GRANT_KINDS = ['path', 'host', 'secret', 'device', 'budget', 'command'] as const;
export type AgentGrantKind = (typeof AGENT_GRANT_KINDS)[number];

export const AGENT_GRANT_STATUSES = ['pending', 'approved', 'once', 'denied', 'revoked'] as const;
export type AgentGrantStatus = (typeof AGENT_GRANT_STATUSES)[number];

/** The owner's three taps on the card. */
export type AgentGrantDecision = 'always' | 'once' | 'deny';

export const AGENT_GRANT_TARGET_MAX_LENGTH = 512;
export const AGENT_GRANT_REASON_MAX_LENGTH = 1_000;

export function isAgentGrantKind(value: unknown): value is AgentGrantKind {
  return typeof value === 'string' && (AGENT_GRANT_KINDS as readonly string[]).includes(value);
}

export function isAgentGrantStatus(value: unknown): value is AgentGrantStatus {
  return typeof value === 'string' && (AGENT_GRANT_STATUSES as readonly string[]).includes(value);
}

/** The verb the card and the profile print in front of a target, per kind. */
export const AGENT_GRANT_VERBS: Readonly<Record<AgentGrantKind, string>> = {
  path: 'read',
  host: 'reach',
  secret: 'use',
  device: 'use',
  budget: 'spend',
  command: 'run',
};

/**
 * A command grant is one exact line the agent may say. Shell metacharacters are
 * refused at request time so a rule can never smuggle a second command, a
 * redirect, or an expansion past the prefix match. Secrets ride as a
 * `--with NAME` suffix, one name per `--with`, and are stripped from the argv.
 */
const SHELL_METACHARACTERS = /[;&|<>$`\\'"(){}\n\r\t*?[\]~#!]/;
const SECRET_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;

export type CommandGrantRule = {
  /** The approved argv prefix, shell-word split on single spaces. */
  readonly argv: readonly string[];
  /** Secret names the rule names with `--with NAME`. */
  readonly secrets: readonly string[];
};

/**
 * Parse and validate a `command` grant target. Throws a plain sentence on any
 * refusal (empty, metacharacters, malformed `--with`), so both the daemon tool
 * and the server reject the same targets with the same words.
 */
export function parseCommandGrantTarget(target: string): CommandGrantRule {
  if (typeof target !== 'string' || !target.trim()) {
    throw new Error('command target is required');
  }
  if (target !== target.trim() || /\s{2,}/.test(target)) {
    throw new Error('command target must be one line with single spaces');
  }
  if (SHELL_METACHARACTERS.test(target)) {
    throw new Error('command target must not contain shell metacharacters');
  }
  const words = target.split(' ');
  const argv: string[] = [];
  const secrets: string[] = [];
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index]!;
    if (word === '--with') {
      const name = words[index + 1];
      if (!name || !SECRET_NAME.test(name)) {
        throw new Error('--with must name one UPPER_CASE secret');
      }
      if (!secrets.includes(name)) secrets.push(name);
      index += 1;
      continue;
    }
    if (secrets.length) throw new Error('--with suffixes must come after the command words');
    argv.push(word);
  }
  if (!argv.length) throw new Error('command target must name a command');
  return { argv, secrets };
}

/** The approved argv must be a prefix of the requested argv, word for word. */
export function commandGrantMatches(rule: CommandGrantRule, requested: readonly string[]): boolean {
  if (requested.length < rule.argv.length) return false;
  return rule.argv.every((word, index) => requested[index] === word);
}

/**
 * The system line the server posts when the owner answers a card. It mentions
 * the agent so the daemon inbox delivers it, and the daemon recognises it
 * structurally through `parseGrantDecisionLine` (plain system lines never wake
 * a turn). Shape: `<name> approved command fly deploy -a preview`.
 */
export type GrantDecisionLine = {
  readonly deciderName: string;
  readonly decision: AgentGrantDecision;
  readonly kind: AgentGrantKind;
  readonly target: string;
};

const DECISION_VERBS: Readonly<Record<AgentGrantDecision, string>> = {
  always: 'approved',
  once: 'approved once',
  deny: 'declined',
};

export function formatGrantDecisionLine(line: GrantDecisionLine): string {
  return `${line.deciderName} ${DECISION_VERBS[line.decision]} ${line.kind} ${line.target}`;
}

const DECISION_LINE = new RegExp(
  `^(.+?) (approved once|approved|declined) (${AGENT_GRANT_KINDS.join('|')}) (.+)$`,
  's',
);

export function parseGrantDecisionLine(body: string): GrantDecisionLine | undefined {
  const match = DECISION_LINE.exec(body);
  if (!match) return undefined;
  const decision: AgentGrantDecision =
    match[2] === 'approved once' ? 'once' : match[2] === 'approved' ? 'always' : 'deny';
  return {
    deciderName: match[1]!,
    decision,
    kind: match[3] as AgentGrantKind,
    target: match[4]!,
  };
}

/**
 * The two hard stops (C94).
 *
 * Trust is granted once, by scope: yolo is that gate, and with it on a granted
 * command just runs — no card, no wait. Per-command approval is more friction
 * than the tools this competes with, and the captain already answered the
 * question when he turned yolo on.
 *
 * Exactly two shapes survive that gate, in a Room and in a corner alike,
 * because reading the transcript afterwards cannot undo them:
 *
 * - `credential`: a credential or environment file, read or written. Matched on
 *   argv words — it catches the shapes below by name, and it does NOT catch a
 *   file reached through an alias, a symlink, a variable the daemon never sees,
 *   or a program that opens one of its own accord.
 * - `unseen-script`: an interpreter or shell over a file whose contents nobody
 *   has read. `python3 fix.py` tells the person deciding nothing about what will
 *   run, so the card carries the script itself and the approval binds to those
 *   bytes ({@link CommandGrantScript}). An interpreter line with no such file
 *   (`python3 -V`) is not a hard stop: there is nothing unseen about it.
 *
 * A wrapper (`env`, `xargs`, `sudo`, …) is deliberately NOT a stop of its own —
 * that was friction with no incident behind it — but the script lookup sees
 * straight through one, so `env python3 fix.py` still binds to `fix.py`.
 */
export const AGENT_GRANT_ESCALATIONS = ['unseen-script', 'credential'] as const;
export type AgentGrantEscalation = (typeof AGENT_GRANT_ESCALATIONS)[number];

export const AGENT_GRANT_ESCALATION_REASONS: Readonly<Record<AgentGrantEscalation, string>> = {
  'unseen-script': 'it runs a script whose contents nobody has read',
  credential: 'it names a credential or environment file',
};

/** One sentence naming why a human has to answer, for a card and for a refusal. */
export function formatGrantEscalationReason(
  escalations: readonly AgentGrantEscalation[],
): string | undefined {
  if (!escalations.length) return undefined;
  return escalations.map((entry) => AGENT_GRANT_ESCALATION_REASONS[entry]).join(' and ');
}

/** Shells and language runtimes: they execute a file the command line does not describe. */
const INTERPRETER_COMMANDS = new Set([
  'sh', 'bash', 'zsh', 'dash', 'ksh', 'ash', 'csh', 'tcsh', 'fish', 'busybox',
  'python', 'python2', 'python3', 'py', 'pypy', 'pypy3',
  'node', 'nodejs', 'deno', 'bun', 'ts-node', 'tsx',
  'ruby', 'irb', 'perl', 'php', 'lua', 'luajit', 'r', 'rscript',
  'osascript', 'pwsh', 'powershell', 'cmd',
]);

/** Wrappers whose real command is an argument; the script lookup steps over them. */
const COMMAND_WRAPPERS = new Set([
  'env', 'xargs', 'nohup', 'setsid', 'time', 'timeout', 'watch', 'script',
  'sudo', 'doas', 'nice', 'ionice', 'stdbuf',
]);

/** Basenames whose whole point is holding a secret. */
const CREDENTIAL_BASENAMES = new Set([
  '.env', '.envrc', '.flaskenv', '.netrc', '_netrc', '.git-credentials', '.pgpass',
  '.npmrc', '.pypirc', '.secrets.env', '.htpasswd', '.dockercfg',
  'credentials', 'credentials.json', 'secrets.json', 'providers.json',
]);

/** Directory names that ARE a key store; a path through one is a credential path. */
const CREDENTIAL_DIRECTORIES = new Set([
  '.ssh', '.gnupg', '.aws', '.azure', '.kube', '.gcloud', '.docker', 'keyrings',
  'gh', 'trusty-squire', 'beeline',
]);

const CREDENTIAL_EXTENSIONS =
  /\.(pem|p12|pfx|key|jks|keystore|kdbx|asc|gpg|ppk|crt|pkcs12)$/i;
const CREDENTIAL_WORD = /(^|[-_.])(secret|secrets|credential|credentials|password|passwd|token|apikey|api_key|keystore|privatekey)([-_.]|$)/i;
const ENV_FILE = /(^|[.\-_])env(\.|$)|^\.env/i;

function commandBasename(word: string): string {
  const tail = word.split(/[/\\]/).pop() ?? word;
  return tail.replace(/\.(exe|cmd|bat)$/i, '').toLowerCase();
}

/** Strip a `--flag=` prefix so `--env-file=.env` is read as the path it carries. */
function pathArgument(word: string): string {
  const equals = word.indexOf('=');
  return word.startsWith('-') && equals > 0 ? word.slice(equals + 1) : word;
}

function namesCredential(word: string): boolean {
  const value = pathArgument(word);
  if (!value) return false;
  const segments = value.split(/[/\\]/).filter(Boolean);
  const base = (segments[segments.length - 1] ?? '').toLowerCase();
  if (!base) return false;
  if (CREDENTIAL_BASENAMES.has(base)) return true;
  if (base.startsWith('.env')) return true;
  if (/^id_(rsa|dsa|ecdsa|ed25519)/.test(base)) return true;
  if (CREDENTIAL_EXTENSIONS.test(base)) return true;
  if (CREDENTIAL_WORD.test(base)) return true;
  if (base.endsWith('.env') || ENV_FILE.test(base)) return true;
  // A path THROUGH a key store, e.g. ~/.ssh/config or ~/.config/gh/hosts.yml.
  return segments.slice(0, -1).some((segment) => CREDENTIAL_DIRECTORIES.has(segment.toLowerCase()));
}

/**
 * Does this argv name a credential or environment file? argv[0] is the command,
 * never a file it opens: `env FOO=1 npm test` wraps a command, it names nothing.
 */
export function namesCredentialFile(argv: readonly string[]): boolean {
  return argv.slice(1).some(namesCredential);
}

/**
 * The hard stops this argv falls into, given what the deciding human has
 * already seen. `seenScript` is the script bytes an existing approval is bound
 * to; pass it at run time so an approved script is no longer "unseen".
 */
export function commandGrantEscalations(
  argv: readonly string[],
  options: { hasScript?: boolean } = {},
): AgentGrantEscalation[] {
  const found = new Set<AgentGrantEscalation>();
  if (options.hasScript) found.add('unseen-script');
  if (namesCredentialFile(argv)) found.add('credential');
  return AGENT_GRANT_ESCALATIONS.filter((entry) => found.has(entry));
}

/**
 * The hard stops the approved RULE itself falls into. `script` is the binding
 * the ask carried: a rule that ships its script is an unseen-script rule, and
 * stays one until a person answers the card that shows it.
 */
export function commandRuleEscalations(
  rule: CommandGrantRule,
  script?: CommandGrantScript,
): AgentGrantEscalation[] {
  return commandGrantEscalations(rule.argv, { hasScript: Boolean(script) });
}

/**
 * What a requested argv escalates into that the approved rule never did.
 *
 * The rule is an argv PREFIX, so a run can always add words the human who
 * answered the card never read. A credential file named by those extra words is
 * a fresh ask, not something the standing approval covers.
 */
export function commandGrantEscalationsBeyondRule(
  rule: CommandGrantRule,
  argv: readonly string[],
): AgentGrantEscalation[] {
  if (!namesCredentialFile(argv)) return [];
  return namesCredentialFile(rule.argv) ? [] : ['credential'];
}

/**
 * An interpreter grant is bound to the SCRIPT, not just to the command line.
 *
 * `python3 fix.py` tells a reader nothing about what will run, and the premise
 * of the whole grant loop is that a person can read a command and judge it. So
 * the daemon reads the script when it raises the ask, the card shows those
 * bytes in the machine role, and the runner refuses at execution unless the
 * file still hashes to what the human saw. An agent that rewrites its script
 * after the card is answered gets a refusal, not a run.
 *
 * The cap is a card a person can actually read on a phone: past
 * {@link GRANT_SCRIPT_MAX_BYTES} / {@link GRANT_SCRIPT_MAX_LINES} the ask is
 * REFUSED rather than truncated — a body that long is a change, and a change
 * belongs in a corner where it is a branch and a pull request.
 */
export const GRANT_SCRIPT_MAX_BYTES = 4_096;
export const GRANT_SCRIPT_MAX_LINES = 120;

export type CommandGrantScript = {
  /** The script argument exactly as it appears in the command line. */
  readonly path: string;
  /** SHA-256 of the bytes the card showed; the runner re-checks it. */
  readonly sha256: string;
  readonly bytes: number;
  /** The whole file. Never truncated — an oversized script is refused instead. */
  readonly contents: string;
};

export function isCommandGrantScript(value: unknown): value is CommandGrantScript {
  if (!value || typeof value !== 'object') return false;
  const script = value as Record<string, unknown>;
  return (
    typeof script.path === 'string' &&
    typeof script.sha256 === 'string' &&
    /^[0-9a-f]{64}$/.test(script.sha256) &&
    typeof script.bytes === 'number' &&
    typeof script.contents === 'string'
  );
}

/** The refusal an oversized script gets, in both the tool and the server. */
export function grantScriptTooLongMessage(path: string, bytes: number, lines: number): string {
  return (
    `${path} is ${bytes} bytes over ${lines} lines: too long to put on an approval card ` +
    `(the cap is ${GRANT_SCRIPT_MAX_BYTES} bytes and ${GRANT_SCRIPT_MAX_LINES} lines). ` +
    'A human must be able to read what they approve, and this will not be truncated. ' +
    'Open a corner with open_corner and make the change there, where it is a branch and a ' +
    'pull request someone can read.'
  );
}

/**
 * The file an interpreter command will run: the first argument that is not a
 * flag. Undefined when the head is not an interpreter, or when the line carries
 * no such argument (`python3 -V`) — that still asks a human, it just has no
 * body to show.
 */
export function interpreterScriptArgument(
  argv: readonly string[],
): { index: number; path: string } | undefined {
  // Step over `env FOO=1 …`, `sudo …`, `timeout 30 …`: the interpreter is what
  // matters, and a wrapper must not be a way around the binding.
  const skippable = (word: string) =>
    word.startsWith('-') || /^[A-Za-z_][A-Za-z0-9_]*=/.test(word) || /^\d+$/.test(word);
  let head = 0;
  while (head < argv.length - 1 && COMMAND_WRAPPERS.has(commandBasename(argv[head]!))) {
    head += 1;
    while (head < argv.length - 1 && skippable(argv[head]!)) head += 1;
  }
  if (!INTERPRETER_COMMANDS.has(commandBasename(argv[head] ?? ''))) return undefined;
  for (let index = head + 1; index < argv.length; index += 1) {
    const word = argv[index]!;
    if (word.startsWith('-')) continue;
    return { index, path: word };
  }
  return undefined;
}
