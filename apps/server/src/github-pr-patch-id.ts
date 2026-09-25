import { execFile } from 'node:child_process';

/** Hash the diff GitHub serves for the PR using the same stable patch identity as the body. */
export function githubPrPatchId(diff: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      'git',
      ['patch-id', '--stable'],
      { maxBuffer: 8 * 1024 * 1024 },
      (error, output) => {
        if (error) return reject(error);
        const id = output.trim().split(/\s+/)[0];
        if (!id || !/^[0-9a-f]{40}$/.test(id))
          return reject(new Error('GitHub diff has no stable patch identity'));
        resolve(id);
      },
    );
    child.stdin?.on('error', reject);
    child.stdin?.end(diff);
  });
}
