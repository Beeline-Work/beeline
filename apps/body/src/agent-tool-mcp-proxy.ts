#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { connect } from 'node:net';
import { pathToFileURL } from 'node:url';

export function isAgentToolMcpProxyMain(
  moduleUrl: string = import.meta.url,
  invokedPath: string | undefined = process.argv[1],
): boolean {
  if (!invokedPath) return false;
  try {
    return moduleUrl === pathToFileURL(realpathSync(invokedPath)).href;
  } catch {
    return false;
  }
}

export async function runAgentToolMcpProxy(input: {
  host: string;
  port: number;
  token: string;
  stdin?: NodeJS.ReadableStream;
  stdout?: NodeJS.WritableStream;
}): Promise<void> {
  const stdin = input.stdin ?? process.stdin;
  const stdout = input.stdout ?? process.stdout;
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const socket = connect({ host: input.host, port: input.port });
    socket.setEncoding('utf8');
    socket.once('connect', () => {
      socket.write(`${JSON.stringify({ token: input.token })}\n`);
      stdin.pipe(socket);
      socket.pipe(stdout);
    });
    socket.once('error', rejectPromise);
    socket.once('close', resolvePromise);
  });
}

if (isAgentToolMcpProxyMain()) {
  const [, , host, rawPort, token] = process.argv;
  const port = Number(rawPort);
  if (!host || !Number.isSafeInteger(port) || port < 1 || port > 65_535 || !token) {
    console.error('invalid Beeline agent-tool broker endpoint');
    process.exitCode = 2;
  } else {
    runAgentToolMcpProxy({ host, port, token }).catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
  }
}

