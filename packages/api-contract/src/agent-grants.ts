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
