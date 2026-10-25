// Safe CreateArtifact duplicate MIME field probe. Upload as duplicate-root.mjs.
// Requires @actions/artifact and @azure/storage-blob at repository root.
// Logs statuses and MIME code points only; never prints tokens or signed URLs.
import {createHash} from 'node:crypto';
import {BlobClient} from '@azure/storage-blob';
import {internalArtifactTwirpClient} from './node_modules/@actions/artifact/lib/internal/shared/artifact-twirp-client.js';
import {getBackendIdsFromToken} from './node_modules/@actions/artifact/lib/internal/shared/util.js';
import {getResultsServiceUrl, getRuntimeToken} from './node_modules/@actions/artifact/lib/internal/shared/config.js';
import {CreateArtifactRequest, CreateArtifactResponse, StringValue} from './node_modules/@actions/artifact/lib/generated/index.js';

const ids = getBackendIdsFromToken();
const client = internalArtifactTwirpClient({maxAttempts: 1});
const endpoint = new URL('/twirp/github.actions.results.api.v1.ArtifactService/CreateArtifact', getResultsServiceUrl());
const good = 'application/json';
const odd = '\u0085application/json';
const body = Buffer.from('{"probe":"duplicate-mime"}');
const hash = StringValue.create({value: `sha256:${createHash('sha256').update(body).digest('hex')}`});
const codes = value => Array.from(value || '', c => c.codePointAt(0));

function varint(n) {
  const out = [];
  while (n >= 128) { out.push((n & 127) | 128); n >>>= 7; }
  out.push(n);
  return Buffer.from(out);
}
function field(number, bytes) {
  return Buffer.concat([varint((number << 3) | 2), varint(bytes.length), bytes]);
}
function wrapper(value) {
  return Buffer.from(StringValue.toBinary(StringValue.create({value})));
}
function jsonPayload(name, mimes, aliases = false) {
  const prefix = `{"workflow_run_backend_id":${JSON.stringify(ids.workflowRunBackendId)},` +
    `"workflow_job_run_backend_id":${JSON.stringify(ids.workflowJobRunBackendId)},` +
    `"name":${JSON.stringify(name)},"version":7,`;
  const a = aliases ? 'mimeType' : 'mime_type';
  return Buffer.from(prefix + `"mime_type":${JSON.stringify(mimes[0])},` +
    `"${a}":${JSON.stringify(mimes[1])}}`);
}

const cases = [
  ['protobuf-good-odd', 'application/protobuf', [good, odd], 'outer'],
  ['protobuf-odd-good', 'application/protobuf', [odd, good], 'outer'],
  ['protobuf-inner-good-odd', 'application/protobuf', [good, odd], 'inner'],
  ['protobuf-inner-odd-good', 'application/protobuf', [odd, good], 'inner'],
  ['json-good-odd', 'application/json', [good, odd], 'duplicate'],
  ['json-odd-good', 'application/json', [odd, good], 'duplicate'],
  ['json-alias-good-odd', 'application/json', [good, odd], 'alias'],
  ['json-alias-odd-good', 'application/json', [odd, good], 'alias'],
];

for (const [label, contentType, mimes, mode] of cases) {
  const name = `benign-duplicate-${process.env.GITHUB_RUN_ID}-${label}`;
  const row = {label, mode};
  let request;
  if (contentType === 'application/protobuf') {
    const base = Buffer.from(CreateArtifactRequest.toBinary(
      CreateArtifactRequest.create({...ids, name, version: 7})));
    request = mode === 'inner'
      ? Buffer.concat([base, field(6, Buffer.concat(mimes.map(mime => field(1, Buffer.from(mime)))))])
      : Buffer.concat([base, ...mimes.map(mime => field(6, wrapper(mime)))]);
  } else {
    request = jsonPayload(name, mimes, mode === 'alias');
  }
  row.requestHasUtf8Nel = request.includes(Buffer.from([0xc2, 0x85]));
  try {
    const response = await fetch(endpoint, {method: 'POST', body: request,
      headers: {'content-type': contentType, authorization: `Bearer ${getRuntimeToken()}`},
      signal: AbortSignal.timeout(15000)});
    const responseBytes = Buffer.from(await response.arrayBuffer());
    row.createStatus = response.status;
    if (response.status !== 200) {
      let error = {};
      try { error = JSON.parse(responseBytes.toString('utf8')); } catch {}
      row.errorCode = String(error.code || '');
      row.errorMessage = String(error.msg || '').replace(/https?:\/\/\S+/g, '<url>').slice(0, 140);
      console.log('DUP-MIME', JSON.stringify(row));
      continue;
    }
    const created = contentType === 'application/protobuf'
      ? CreateArtifactResponse.fromBinary(responseBytes)
      : JSON.parse(responseBytes.toString('utf8'));
    const uploadUrl = created.signedUploadUrl || created.signed_upload_url;
    if (!uploadUrl) { row.stageError = 'create-response'; console.log('DUP-MIME', JSON.stringify(row)); continue; }
    await new BlobClient(uploadUrl).getBlockBlobClient().uploadData(body,
      {blobHTTPHeaders: {blobContentType: good}});
    row.upload = true;
    const finalized = await client.FinalizeArtifact({...ids, name, size: String(body.length), hash});
    row.finalize = Boolean(finalized.ok);
    const signed = (await client.GetSignedArtifactURL({...ids, name})).signedUrl;
    row.rsctCodes = codes(new URL(signed).searchParams.get('rsct') || '');
  } catch {
    row.stageError = 'request-upload-finalize-sign';
  }
  console.log('DUP-MIME', JSON.stringify(row));
}
