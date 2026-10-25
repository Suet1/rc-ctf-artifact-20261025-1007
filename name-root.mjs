// Copy into a Node 24 JavaScript action. Benign name/query-boundary tests.
// Requires @actions/artifact and @azure/storage-blob at repository root.
// Never prints signed URLs, credentials, or response bodies.
import https from 'node:https';
import {createHash} from 'node:crypto';
import {BlobClient} from '@azure/storage-blob';
import {internalArtifactTwirpClient} from './node_modules/@actions/artifact/lib/internal/shared/artifact-twirp-client.js';
import {getBackendIdsFromToken} from './node_modules/@actions/artifact/lib/internal/shared/util.js';
import {StringValue} from './node_modules/@actions/artifact/lib/generated/index.js';

const ids = getBackendIdsFromToken();
const client = internalArtifactTwirpClient({maxAttempts: 1});
const body = Buffer.from('{"probe":"artifact-name"}');
const hash = StringValue.create({value: `sha256:${createHash('sha256').update(body).digest('hex')}`});
const blobMime = '\u0085application/json';
const codes = s => Array.from(s || '', c => c.codePointAt(0));
const cases = [
  ['hash', '#fragment'],
  ['question', '?fragment'],
  ['amp', '&rsct=application%2Fx-ctf-probe'],
  ['percent-hash', '%23fragment'],
  ['percent-question', '%3Frsct%3Dapplication%2Fx-ctf-probe'],
  ['hash-amp', '#&rsct=application%2Fx-ctf-probe'],
];

async function header(url) {
  return new Promise(resolve => {
    const req = https.get(url, {timeout: 12000}, res => {
      const type = res.headers['content-type'] || '';
      res.resume();
      res.on('end', () => resolve({status: res.statusCode, type: codes(type)}));
    });
    req.on('timeout', () => req.destroy());
    req.on('error', error => resolve({status: 0, error: error.code || 'http-error'}));
  });
}

for (const [label, suffix] of cases) {
  const name = `ctf-name-${process.env.GITHUB_RUN_ID}-${label}${suffix}.json`;
  let uploadUrl;
  try {
    uploadUrl = (await client.CreateArtifact({...ids, name, version: 7,
      mimeType: StringValue.create({value: 'application/json'})})).signedUploadUrl;
  } catch {
    console.log('NAME', JSON.stringify({label, create: false}));
    continue;
  }
  let uploaded = false;
  try {
    await new BlobClient(uploadUrl).getBlockBlobClient().uploadData(body, {
      blobHTTPHeaders: {blobContentType: blobMime},
    });
    uploaded = true;
  } catch {}
  let finalized = false;
  if (uploaded) {
    try {
      await client.FinalizeArtifact({...ids, name, size: String(body.length), hash});
      finalized = true;
    } catch {}
  }
  let query = {};
  let observed = {};
  if (finalized) {
    try {
      const signed = (await client.GetSignedArtifactURL({...ids, name})).signedUrl;
      const url = new URL(signed);
      query = {rsct: codes(url.searchParams.get('rsct')),
        rsctCount: url.searchParams.getAll('rsct').length,
        fragmentLength: url.hash.length,
        rscdContainsSuffix: (url.searchParams.get('rscd') || '').includes(suffix)};
      observed = await header(signed);
    } catch {}
  }
  console.log('NAME', JSON.stringify({label, create: true, uploaded,
    finalized, query, observed}));
}
