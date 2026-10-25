// Benign Actions Results protocol probe. Upload as artifact-action/version_matrix_probe.mjs.
// Requires @actions/artifact and @azure/storage-blob at repository root.
// Prints only status and Content-Type code points, never signed URLs or credentials.
import {createHash} from 'node:crypto';
import {BlobClient} from '@azure/storage-blob';
import {internalArtifactTwirpClient} from '../node_modules/@actions/artifact/lib/internal/shared/artifact-twirp-client.js';
import {getBackendIdsFromToken} from '../node_modules/@actions/artifact/lib/internal/shared/util.js';
import {StringValue} from '../node_modules/@actions/artifact/lib/generated/index.js';

const ids = getBackendIdsFromToken();
const client = internalArtifactTwirpClient({maxAttempts: 1});
const body = Buffer.from('{"probe":"version-matrix"}');
const hash = StringValue.create({value: `sha256:${createHash('sha256').update(body).digest('hex')}`});
const odd = '\u0085application/json';

for (const version of [0, 1, 2, 3, 4, 5]) {
  const name = `benign-version-${process.env.GITHUB_RUN_ID}-${version}`;
  const row = {version};
  try {
    const created = await client.CreateArtifact({...ids, name, version,
      mimeType: StringValue.create({value: odd})});
    row.create = true;
    try {
      await new BlobClient(created.signedUploadUrl).getBlockBlobClient().uploadData(body,
        {blobHTTPHeaders: {blobContentType: 'application/json'}});
      row.upload = true;
      const finalized = await client.FinalizeArtifact({...ids, name,
        size: String(body.length), hash});
      row.finalize = Boolean(finalized.ok);
      const signed = await client.GetSignedArtifactURL({...ids, name});
      const type = new URL(signed.signedUrl).searchParams.get('rsct') || '';
      row.rsctCodes = Array.from(type, c => c.codePointAt(0));
    } catch (error) {
      row.stageError = error?.statusCode || error?.code || 'upload-finalize-sign';
    }
  } catch (error) {
    row.create = false;
    row.stageError = error?.statusCode || error?.code || 'create';
  }
  console.log('VERSION-MATRIX', JSON.stringify(row));
}

// Check whether Azure treats duplicate signed response overrides as an error,
// or permits a different Content-Type to be selected. This uses benign bytes.
const control = {label: 'v7-duplicate-rsct'};
try {
  const name = `benign-v7-rsct-${process.env.GITHUB_RUN_ID}`;
  const created = await client.CreateArtifact({...ids, name, version: 7,
    mimeType: StringValue.create({value: 'application/json'})});
  await new BlobClient(created.signedUploadUrl).getBlockBlobClient().uploadData(body,
    {blobHTTPHeaders: {blobContentType: 'application/json'}});
  await client.FinalizeArtifact({...ids, name, size: String(body.length), hash});
  const signed = (await client.GetSignedArtifactURL({...ids, name})).signedUrl;
  const delimiter = signed.indexOf('?');
  const extra = 'rsct=application%2Fx-ctf-probe';
  const cases = [
    ['original', signed],
    ['append', `${signed}&${extra}`],
    ['prepend', `${signed.slice(0, delimiter + 1)}${extra}&${signed.slice(delimiter + 1)}`],
  ];
  for (const [label, url] of cases) {
    try {
      const response = await fetch(url, {redirect: 'manual'});
      control[label] = {status: response.status,
        typeCodes: Array.from(response.headers.get('content-type') || '', c => c.codePointAt(0))};
      await response.arrayBuffer();
    } catch {
      control[label] = {status: 0};
    }
  }
} catch {
  control.stageError = 'create-upload-finalize-sign';
}
console.log('VERSION-MATRIX', JSON.stringify(control));
