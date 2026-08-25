#!/usr/bin/env node
import { connect } from 'node:net';
import { pathToFileURL } from 'node:url';

export async function runSquireMcpProxy(input: {
  host: string;
  port: number;
  token: string;
  stdin?: NodeJS.ReadableStream;
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
}): Promise<void> {
  const stdin = input.stdin ?? process.stdin;
  const stdout = input.stdout ?? process.stdout;
  const stderr = input.stderr ?? process.stderr;
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const socket = connect({ host: input.host, port: input.port });
    socket.setEncoding('utf8');
    socket.once('connect', () => {
      socket.write(`${JSON.stringify({ token: input.token })}\n`);
      stdin.pipe(socket);
      socket.pipe(stdout);
    });
    socket.on('error', rejectPromise);
    socket.on('close', () => resolvePromise());
    stderr.on?.('error', rejectPromise);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [, , host, rawPort, token] = process.argv;
  const port = Number(rawPort);
  if (!host || !Number.isSafeInteger(port) || port < 1 || port > 65_535 || !token) {
    console.error('invalid Trusty Squire broker endpoint');
    process.exitCode = 2;
  } else {
    runSquireMcpProxy({ host, port, token }).catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
  }
}
