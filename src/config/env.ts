export function getEnvVar(name: string): string | undefined {
  const metaEnv = (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env;
  const fromMeta = metaEnv?.[name];
  if (typeof fromMeta === "string") {
    return fromMeta;
  }

  const fromBun = (globalThis as { Bun?: { env?: Record<string, string | undefined> } }).Bun?.env?.[name];
  if (typeof fromBun === "string") {
    return fromBun;
  }

  const fromProcess = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.[name];
  if (typeof fromProcess === "string") {
    return fromProcess;
  }

  return undefined;
}
