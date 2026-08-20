/**
 * `session/new` `configOptions` captured VERBATIM from a real
 * `@agentclientprotocol/codex-acp` process (codex-acp on PATH, 2026-08-20).
 *
 * Codex does not use `{ id }` on each choice. It uses `{ value, name,
 * description }`. `parseAdvertisedConfigOptions` used to require `choice.id`,
 * so a successful catalog fetch produced empty option lists and
 * `pickModelAndEffort` skipped both pickers — "loads the catalog, does not
 * allow the user to pick". Claude-shaped catalogs (`{ id, name }`) were never
 * affected; #226's pickers were built against that shape.
 *
 * `mode` / `collaboration_mode` / `fast-mode` stay in the raw capture so the
 * allow-list filter is tested against a real Codex catalog, not a toy one.
 */
export const CODEX_ACP_SESSION_NEW_CONFIG_OPTIONS = {
  sessionId: 'codex-session-fixture',
  configOptions: [
    {
      id: 'mode',
      category: 'mode',
      currentValue: 'agent',
      options: [
        {
          value: 'read-only',
          name: 'Read-only',
          description: 'Requires approval to edit files and run commands.',
        },
        { value: 'agent', name: 'Agent', description: 'Read and edit files, and run commands.' },
        {
          value: 'agent-full-access',
          name: 'Agent (full access)',
          description:
            'Codex can edit files outside this workspace and run commands with network access. Exercise caution when using.',
        },
      ],
    },
    {
      id: 'collaboration_mode',
      category: 'collaboration_mode',
      currentValue: 'default',
      options: [
        { value: 'default', name: 'Default' },
        { value: 'plan', name: 'Plan', description: 'Plan before making changes' },
      ],
    },
    {
      id: 'model',
      category: 'model',
      currentValue: 'gpt-5.6-sol',
      options: [
        {
          value: 'gpt-5.6-sol',
          name: 'GPT-5.6-Sol',
          description: 'Latest frontier agentic coding model.',
        },
        {
          value: 'gpt-5.6-terra',
          name: 'GPT-5.6-Terra',
          description: 'Balanced agentic coding model for everyday work.',
        },
        {
          value: 'gpt-5.6-luna',
          name: 'GPT-5.6-Luna',
          description: 'Fast and affordable agentic coding model.',
        },
        {
          value: 'gpt-5.5',
          name: 'GPT-5.5',
          description: 'Frontier model for complex coding, research, and real-world work.',
        },
        { value: 'gpt-5.4', name: 'GPT-5.4', description: 'Strong model for everyday coding.' },
        {
          value: 'gpt-5.4-mini',
          name: 'GPT-5.4-Mini',
          description: 'Small, fast, and cost-efficient model for simpler coding tasks.',
        },
        {
          value: 'gpt-5.3-codex-spark',
          name: 'GPT-5.3-Codex-Spark',
          description: 'Ultra-fast coding model.',
        },
      ],
    },
    {
      id: 'reasoning_effort',
      category: 'thought_level',
      currentValue: 'high',
      options: [
        { value: 'low', name: 'Low', description: 'Fast responses with lighter reasoning' },
        {
          value: 'medium',
          name: 'Medium',
          description: 'Balances speed and reasoning depth for everyday tasks',
        },
        { value: 'high', name: 'High', description: 'Greater reasoning depth for complex problems' },
        {
          value: 'xhigh',
          name: 'Xhigh',
          description: 'Extra high reasoning depth for complex problems',
        },
        {
          value: 'max',
          name: 'Max',
          description: 'Maximum reasoning depth for the hardest problems',
        },
        {
          value: 'ultra',
          name: 'Ultra',
          description: 'Maximum reasoning with automatic task delegation',
        },
      ],
    },
    {
      id: 'fast-mode',
      category: 'model_config',
      currentValue: 'off',
      options: [
        { value: 'off', name: 'Off', description: 'Default speed, normal usage' },
        { value: 'on', name: 'On', description: '1.5x speed, increased usage' },
      ],
    },
  ],
};
