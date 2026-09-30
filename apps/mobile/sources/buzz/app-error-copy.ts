export function appErrorCopy(message: string): string {
  const provider = message.match(/App provider request failed \((\d{3})\)/);
  if (provider) return `The app provider refused this connection (${provider[1]}). Try again or ask the owner to check provider access.`;
  return message.replace(/^Monolith \w+ failed \(\d+\):\s*/, '');
}
