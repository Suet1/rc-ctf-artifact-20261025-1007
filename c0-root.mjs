// Copy into an existing Node 24 JavaScript action. Benign v7 MIME matrix.
// Requires @actions/artifact and @azure/storage-blob at repository root.
// Logs no runtime token, signed URL, or response body.
import https from 'node:https';
import {createHash} from 'node:crypto';
import {BlobClient} from '@azure/storage-blob';
import {internalArtifactTwirpClient} from './node_modules/@actions/artifact/lib/internal/shared/artifact-twirp-client.js';
import {getBackendIdsFromToken} from './node_modules/@actions/artifact/lib/internal/shared/util.js';
import {StringValue} from './node_modules/@actions/artifact/lib/generated/index.js';

const ids = getBackendIdsFromToken();
const client = internalArtifactTwirpClient({maxAttempts: 1});
const body = Buffer.from('{"probe":"c0-mime"}');
const hash = StringValue.create({value: `sha256:${createHash('sha256').update(body).digest('hex')}`});
const codes = s => Array.from(s || '', c => c.codePointAt(0));

async function downloadHeader(url) {
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

for (const point of [0x1c, 0x1d, 0x1e, 0x1f, 0x85]) {
  const mime = String.fromCharCode(point) + 'application/json';
  const name = `ctf-c0-${process.env.GITHUB_RUN_ID}-${point}`;
  let uploadUrl;
  try {
    uploadUrl = (await client.CreateArtifact({...ids, name, version: 7,
      mimeType: StringValue.create({value: mime})})).signedUploadUrl;
  } catch {
    console.log('C0', JSON.stringify({point, create: false}));
    continue;
  }
  let uploaded = false;
  try {
    await new BlobClient(uploadUrl).getBlockBlobClient().uploadData(body, {
      blobHTTPHeaders: {blobContentType: mime},
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
  let rsct = '';
  let header = {};
  if (finalized) {
    try {
      const url = (await client.GetSignedArtifactURL({...ids, name})).signedUrl;
      rsct = new URL(url).searchParams.get('rsct') || '';
      header = await downloadHeader(url);
    } catch {}
  }
  console.log('C0', JSON.stringify({point, create: true, uploaded, finalized,
    rsct: codes(rsct), header}));
}
