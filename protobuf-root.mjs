// Safe v7 Actions Results probe: valid UTF-8 U+0085 via binary protobuf.
// Upload as protobuf-root.mjs in a Node 24 JS action.
// Requires @actions/artifact and @azure/storage-blob at repository root.
// Logs no credentials, signed URLs, repository contents, or sensitive data.
import {createHash} from 'node:crypto';
import {BlobClient} from '@azure/storage-blob';
import {internalArtifactTwirpClient} from './node_modules/@actions/artifact/lib/internal/shared/artifact-twirp-client.js';
import {getBackendIdsFromToken} from './node_modules/@actions/artifact/lib/internal/shared/util.js';
import {getResultsServiceUrl, getRuntimeToken} from './node_modules/@actions/artifact/lib/internal/shared/config.js';
import {CreateArtifactRequest, CreateArtifactResponse, StringValue} from './node_modules/@actions/artifact/lib/generated/index.js';

const codes = value => Array.from(value || '', c => c.codePointAt(0));
const ids = getBackendIdsFromToken();
const name = `benign-binary-nel-${process.env.GITHUB_RUN_ID}`;
const mime = '\u0085application/json';
const body = Buffer.from('{"probe":"valid-utf8-binary-nel"}');
const hash = StringValue.create({value: `sha256:${createHash('sha256').update(body).digest('hex')}`});
const row = {stage: 'create', mimeCodepoints: codes(mime)};

const request = CreateArtifactRequest.create({...ids, name, version: 7,
  mimeType: StringValue.create({value: mime})});
const encoded = Buffer.from(CreateArtifactRequest.toBinary(request));
row.hasUtf8Nel = encoded.includes(Buffer.from([0xc2, 0x85]));
const endpoint = new URL('/twirp/github.actions.results.api.v1.ArtifactService/CreateArtifact',
  getResultsServiceUrl());
const created = await fetch(endpoint, {
  method: 'POST',
  body: encoded,
  headers: {'content-type': 'application/protobuf',
    authorization: `Bearer ${getRuntimeToken()}`},
  signal: AbortSignal.timeout(15000),
});
const createdBytes = Buffer.from(await created.arrayBuffer());
row.createStatus = created.status;
if (created.status !== 200) {
  let error = {};
  try { error = JSON.parse(createdBytes.toString('utf8')); } catch {}
  row.errorCode = String(error.code || '');
  row.errorMessage = String(error.msg || '').replace(/https?:\/\/\S+/g, '<url>').slice(0, 180);
  console.log('BINARY-NEL', JSON.stringify(row));
  process.exit(0);
}

let uploadUrl;
try { uploadUrl = CreateArtifactResponse.fromBinary(createdBytes).signedUploadUrl; }
catch { row.responseDecode = false; }
if (!uploadUrl) {
  console.log('BINARY-NEL', JSON.stringify(row));
  process.exit(0);
}
row.responseDecode = true;

try {
  await new BlobClient(uploadUrl).getBlockBlobClient().uploadData(body,
    {blobHTTPHeaders: {blobContentType: 'application/json'}});
  row.upload = true;
  const client = internalArtifactTwirpClient({maxAttempts: 1});
  const finalized = await client.FinalizeArtifact({...ids, name,
    size: String(body.length), hash});
  row.finalize = Boolean(finalized.ok);
  row.artifactId = String(finalized.artifactId || '');
  const signed = (await client.GetSignedArtifactURL({...ids, name})).signedUrl;
  row.signedRsctCodes = codes(new URL(signed).searchParams.get('rsct') || '');
  const direct = await fetch(signed);
  row.directStatus = direct.status;
  row.directTypeCodes = codes(direct.headers.get('content-type') || '');
  row.directBodyMatch = Buffer.from(await direct.arrayBuffer()).equals(body);
  if (row.artifactId) {
    const restUrl = `https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}/actions/artifacts/${row.artifactId}/zip`;
    const rest = await fetch(restUrl, {redirect: 'manual',
      headers: {authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
        accept: 'application/vnd.github.v3+json',
        'user-agent': 'repo-cassette-binary-nel-probe'}});
    row.restStatus = rest.status;
    if (rest.headers.get('location')) {
      row.restRsctCodes = codes(new URL(rest.headers.get('location')).searchParams.get('rsct') || '');
    }
  }
} catch {
  row.stageError = 'upload-finalize-download';
}
console.log('BINARY-NEL', JSON.stringify(row));
