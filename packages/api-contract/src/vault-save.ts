/** Public card metadata. Secret values are deliberately absent from this type. */
export interface VaultSaveRequest {
  readonly service: string;
  readonly label: string;
  readonly purpose: string;
  readonly fields: readonly {
    readonly name: string;
    readonly label: string;
    readonly secret: boolean;
  }[];
  readonly allowedHosts: readonly string[];
  readonly authStrategy: 'api_key' | 'username_password';
}

export interface VaultSaveCard extends VaultSaveRequest {
  readonly agentId: string;
  readonly ownerId: string;
  readonly ownerName: string;
  readonly status: 'pending' | 'saving' | 'saved';
  readonly savedAt?: number;
  readonly reference?: string;
}

export function readVaultSaveCard(input: unknown): VaultSaveCard | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const o = input as Record<string, unknown>;
  try {
    const metadata = vaultSaveRequest({
      service: o.service,
      label: o.label,
      purpose: o.purpose,
      fields: o.fields,
      allowedHosts: o.allowedHosts,
      authStrategy: o.authStrategy,
    });
    if (
      typeof o.agentId !== 'string' ||
      typeof o.ownerId !== 'string' ||
      typeof o.ownerName !== 'string' ||
      !['pending', 'saving', 'saved'].includes(String(o.status))
    )
      return undefined;
    if (
      o.status === 'saved' &&
      (typeof o.savedAt !== 'number' ||
        !Number.isFinite(o.savedAt) ||
        typeof o.reference !== 'string' ||
        !/^vault:\/\/[a-zA-Z0-9_./:-]{1,240}$/.test(o.reference))
    )
      return undefined;
    return {
      ...metadata,
      agentId: o.agentId,
      ownerId: o.ownerId,
      ownerName: o.ownerName,
      status: o.status as VaultSaveCard['status'],
      ...(o.status === 'saved'
        ? { savedAt: o.savedAt as number, reference: o.reference as string }
        : {}),
    };
  } catch {
    return undefined;
  }
}

/** Strictly select metadata so an upstream result cannot smuggle a value into a card. */
export function vaultSaveRequest(input: unknown): VaultSaveRequest {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new Error('invalid vault request');
  const o = input as Record<string, unknown>;
  const permitted = [
    'service',
    'label',
    'purpose',
    'fields',
    'allowedHosts',
    'authStrategy',
    'roomId',
    'requestId',
    'generationId',
    'taskId',
    'toolCallId',
  ];
  if (Object.keys(o).some((key) => !permitted.includes(key)))
    throw new Error('invalid vault request fields');
  const word = (value: unknown, limit: number): string => {
    if (
      typeof value !== 'string' ||
      !value.trim() ||
      value.length > limit ||
      /[\r\n\0]/.test(value)
    )
      throw new Error('invalid vault metadata');
    return value.trim();
  };
  const service = word(o.service, 80);
  const label = word(o.label, 80);
  const purpose = word(o.purpose, 240);
  if (!Array.isArray(o.fields) || o.fields.length < 1 || o.fields.length > 12)
    throw new Error('invalid vault fields');
  const fields = o.fields.map((field: unknown) => {
    if (!field || typeof field !== 'object') throw new Error('invalid vault field');
    const f = field as Record<string, unknown>;
    if (
      Object.keys(f).some((key) => !['name', 'label', 'secret'].includes(key)) ||
      typeof f.secret !== 'boolean'
    )
      throw new Error('invalid vault field');
    const name = word(f.name, 64);
    if (!/^[a-z][a-z0-9_]*$/.test(name)) throw new Error('invalid vault field name');
    if (['pan', 'cvv', 'cvc', 'card_number', 'cardholder', 'expiry'].includes(name))
      throw new Error('payment card fields are invalid for this tool');
    if (/(?:password|secret|token|api_key)/.test(name) && !f.secret)
      throw new Error('secret vault fields must be masked');
    return { name, label: word(f.label, 80), secret: f.secret };
  });
  if (new Set(fields.map((f) => f.name)).size !== fields.length)
    throw new Error('invalid duplicate vault fields');
  if (!Array.isArray(o.allowedHosts) || !o.allowedHosts.length || o.allowedHosts.length > 16)
    throw new Error('invalid vault hosts');
  const allowedHosts = o.allowedHosts.map((host) => {
    const value = word(host, 253).toLowerCase();
    if (!/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/.test(value))
      throw new Error('invalid vault host');
    return value;
  });
  if (o.authStrategy !== 'api_key' && o.authStrategy !== 'username_password')
    throw new Error('invalid vault auth strategy');
  return { service, label, purpose, fields, allowedHosts, authStrategy: o.authStrategy };
}

export function vaultSaveValues(request: VaultSaveRequest, input: unknown): Record<string, string> {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new Error('invalid vault values');
  const values = input as Record<string, unknown>;
  if (Object.keys(values).length !== request.fields.length) throw new Error('invalid vault values');
  const result: Record<string, string> = Object.create(null);
  for (const field of request.fields) {
    const value = values[field.name];
    if (typeof value !== 'string' || !value.length || value.length > 16_384)
      throw new Error('invalid vault values');
    result[field.name] = value;
  }
  return result;
}
