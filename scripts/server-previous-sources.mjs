import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const tag = image => String(image ?? '').replace(/@sha256:[a-f0-9]+$/, '');
const labelSha = labels => {
  const sha = labels?.['app.usebeeline.release.sha'];
  if (sha === undefined) return undefined;
  if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error('Invalid server source image label; refusing schema changes');
  return sha;
};

export function previousSources(machines, currentImage, extraImages = [], inspectLabels = image => {
  // A saved rollback reference may no longer belong to a running Machine.
  // Pull that exact image and read its own labels, never the replacing image's.
  execFileSync('flyctl', ['auth', 'docker'], { stdio: ['ignore', 'ignore', 'inherit'] });
  execFileSync('docker', ['pull', image], { stdio: ['ignore', 'ignore', 'inherit'] });
  return JSON.parse(execFileSync('docker', ['image', 'inspect', '--format', '{{json .Config.Labels}}', image], { encoding: 'utf8' }));
}) {
  if (!machines.length) throw new Error('Cannot identify the previous server source; refusing schema changes');
  const refs = machines.map(machine => {
    const image = machine.config?.image ?? machine.imageRef;
    return tag(image) === tag(currentImage) ? machine.config?.metadata?.beeline_replaced_image : image;
  });
  refs.push(...extraImages.filter(Boolean));
  return [...new Set([...new Set(refs)].map(image => {
    if (!image) throw new Error('Cannot identify the previous server source; refusing schema changes');
    const matching = machines.filter(machine => tag(machine.config?.image ?? machine.imageRef) === tag(image));
    const labels = [...new Set(matching.map(machine => labelSha(machine.image_ref?.labels)).filter(Boolean))];
    if (labels.length > 1) throw new Error('Conflicting server source image labels; refusing schema changes');
    if (labels.length) return labels[0];
    const sha = image.match(/-([a-f0-9]{12,40})(?:@sha256:[a-f0-9]+)?$/)?.[1];
    if (sha) return sha;
    // Only Fly deployment references are eligible for registry resolution.
    if (/^registry\.fly\.io\/beeline-server:deployment-[0-9A-Z]+(?:@sha256:[a-f0-9]+)?$/.test(image)) {
      const resolved = labelSha(inspectLabels(image));
      if (resolved) return resolved;
    }
    throw new Error('Cannot identify the previous server source; refusing schema changes');
  }))];
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const machines = JSON.parse(readFileSync(process.argv[2], 'utf8'));
  const sources = previousSources(machines, process.argv[3], [process.env.PUBLISHED_SERVER_IMAGE, process.env.ROLLBACK_SERVER_IMAGE]);
  console.log(sources.join('\n'));
}
