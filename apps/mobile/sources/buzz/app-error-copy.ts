export const connectionErrorTitle = 'Couldn’t reach Beeline';
export const connectionErrorDescription = 'Check your connection and try again.';

/** Keep transport diagnostics out of the text a person reads. */
export function appErrorCopy(reason: unknown, fallback = 'Could not complete request'): string {
  const record = reason && typeof reason === 'object' ? reason as Record<string, unknown> : undefined;
  const message = typeof reason === 'string' ? reason : typeof record?.message === 'string' ? record.message : '';
  const status = typeof record?.status === 'number' ? record.status : Number(message.match(/(?:\(|\bHTTP(?: status)?[ :]+)([45]\d{2})\b/)?.[1]);
  const clientFailure = status >= 400 && status < 500;
  if (status >= 500 || (!clientFailure && /network request failed|failed to fetch|networkerror|timed? ?out|timeout|load failed/i.test(message + ' ' + (record?.name ?? '')))) return connectionErrorTitle;
  if (record && !clientFailure) return fallback;
  const serverMessage = clientFailure && typeof record?.code === 'string' && !/^[\w.-]+$/.test(record.code) ? record.code : message;
  const human = serverMessage.replace(/^Monolith \w+ failed \(\d+\):\s*/, '').trim();
  if (!human || /\b\w*Error\b|(?:\bHTTP[ :]+[45]\d{2}|\([45]\d{2}\b)|\b[a-z]+(?:_[a-z]+)+\b|request failed/i.test(human)) return fallback;
  return human;
}
