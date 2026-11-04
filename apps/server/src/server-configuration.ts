/** Shared server configuration access, extracted from the startup entrypoint. */
export function serverSetting(name: string): string | undefined { return process.env[name]; }
export function requiredServerSetting(name: string): string {
  const value = serverSetting(name);
  if (!value) throw new Error(`${name} is required`);
  return value;
}
