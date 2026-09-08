import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { downloadPagesChannel, publishPagesChannel, CHANNEL_TAG } from './pages-channel.mjs';

const repo = { owner: 'example', repo: 'beeline' };
async function fixture(directory, version = 'v0.0.63') {
  await mkdir(directory, { recursive: true });
  const bytes = Buffer.from(`verified bundle ${version}`);
  const file = 'beeline-linux-x64.tar.gz';
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const manifest = {
    schemaVersion: 1,
    sourceCommit: 'a'.repeat(40),
    version,
    bundles: {
      'linux-x64': {
        file,
        sha256,
        bytes: bytes.length,
        verified: true,
        commit: 'a'.repeat(40),
        version,
      },
    },
  };
  await writeFile(join(directory, file), bytes);
  await writeFile(join(directory, `${file}.sha256`), `${sha256}  ${file}\n`);
  await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest));
  return manifest;
}
function githubFixture() {
  let release;
  let nextId = 1;
  const bytes = new Map();
  const uploads = [];
  const repos = {
    async getReleaseByTag({ tag }) {
      assert.equal(tag, CHANNEL_TAG);
      if (!release) throw Object.assign(new Error('not found'), { status: 404 });
      return { data: structuredClone(release) };
    },
    async createRelease(input) {
      assert.equal(input.make_latest, 'false');
      assert.equal(input.prerelease, true);
      release = { id: 1, assets: [] };
      return { data: structuredClone(release) };
    },
    async deleteReleaseAsset({ asset_id }) {
      release.assets = release.assets.filter((asset) => asset.id !== asset_id);
      bytes.delete(asset_id);
    },
    async uploadReleaseAsset({ name, data }) {
      const id = nextId++;
      uploads.push(name);
      release.assets.push({ id, name });
      bytes.set(id, Buffer.from(data));
    },
    async getReleaseAsset({ asset_id, headers }) {
      assert.equal(headers.accept, 'application/octet-stream');
      return { data: Uint8Array.from(bytes.get(asset_id)).buffer };
    },
  };
  return { github: { rest: { repos } }, uploads, bytes };
}

test('release bytes survive outside the checkout and replay on a website-only deploy', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pages-channel-'));
  try {
    const source = join(root, 'source');
    const expected = await fixture(source);
    const { github, uploads } = githubFixture();
    await publishPagesChannel({
      github,
      repo,
      directory: source,
      expectedSha: expected.sourceCommit,
      expectedVersion: expected.version,
    });
    assert.equal(uploads.at(-1), 'manifest.json');
    await rm(source, { recursive: true });
    const output = join(root, 'download');
    assert.deepEqual(await downloadPagesChannel({ github, repo, directory: output }), expected);
    assert.equal(
      (await readFile(join(output, 'beeline-linux-x64.tar.gz'))).toString(),
      'verified bundle v0.0.63',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('partial upload fails closed and a release retry repairs the durable channel', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pages-channel-'));
  try {
    const source = join(root, 'source');
    const { github } = githubFixture();
    await fixture(source);
    await publishPagesChannel({ github, repo, directory: source });
    const next = await fixture(source, 'v0.0.64');
    const upload = github.rest.repos.uploadReleaseAsset;
    github.rest.repos.uploadReleaseAsset = async (args) => {
      if (args.name.endsWith('.sha256')) throw new Error('interrupted upload');
      return upload(args);
    };
    await assert.rejects(publishPagesChannel({ github, repo, directory: source }), /interrupted/);
    await assert.rejects(
      downloadPagesChannel({ github, repo, directory: join(root, 'partial') }),
      /missing/,
    );
    github.rest.repos.uploadReleaseAsset = upload;
    await publishPagesChannel({ github, repo, directory: source });
    assert.deepEqual(
      await downloadPagesChannel({ github, repo, directory: join(root, 'repaired') }),
      next,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('wrong release identity or corrupt bytes cannot mutate the durable channel', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pages-channel-'));
  try {
    const manifest = await fixture(root);
    const { github, uploads } = githubFixture();
    await assert.rejects(
      publishPagesChannel({ github, repo, directory: root, expectedVersion: 'v0.0.64' }),
      /differs/,
    );
    await writeFile(join(root, manifest.bundles['linux-x64'].file), 'corrupt');
    await assert.rejects(publishPagesChannel({ github, repo, directory: root }), /sha256/);
    assert.deepEqual(uploads, []);
    await assert.rejects(
      downloadPagesChannel({ github, repo, directory: join(root, 'missing') }),
      /not found/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
