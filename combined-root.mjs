// Safe v7 artifact name/MIME/SAS header probe; upload as combined-root.mjs.
// Requires @actions/artifact and @azure/storage-blob at repository root.
// Never prints tokens, URLs, response bodies, or signed SAS values.
import https from 'node:https';
import {createHash} from 'node:crypto';
import {BlobClient} from '@azure/storage-blob';
import {internalArtifactTwirpClient} from './node_modules/@actions/artifact/lib/internal/shared/artifact-twirp-client.js';
import {getBackendIdsFromToken} from './node_modules/@actions/artifact/lib/internal/shared/util.js';
import {StringValue} from './node_modules/@actions/artifact/lib/generated/index.js';

const ids = getBackendIdsFromToken();
const client = internalArtifactTwirpClient({maxAttempts: 1});
const body = Buffer.from('{"probe":"combined-header"}');
const hash = StringValue.create({value: `sha256:${createHash('sha256').update(body).digest('hex')}`});
const codes = value => Array.from(value || '', c => c.codePointAt(0));
const cases = [
  {label: 'name-percent26', suffix: '%26rsct%3Dapplication%2Fjson', mime: 'application/json'},
  {label: 'name-double-percent26', suffix: '%2526rsct%3Dapplication%2Fjson', mime: 'application/json'},
  {label: 'name-question', suffix: '?rsct=application%2Fjson', mime: 'application/json'},
  {label: 'name-hash', suffix: '#rsct=application%2Fjson', mime: 'application/json'},
  {label: 'mime-octet', suffix: '', mime: 'application/octet-stream'},
  {label: 'mime-binary', suffix: '', mime: 'binary/octet-stream'},
  {label: 'mime-text', suffix: '', mime: 'text/plain'},
  {label: 'mime-wildcard', suffix: '', mime: '*/*'},
];

function readRawHeaders(url) {
  return new Promise(resolve => {
    const request = https.get(url, {timeout: 12000}, response => {
      const rawTypes = [];
      const rawDispositions = [];
      for (let i = 0; i < response.rawHeaders.length; i += 2) {
        const key = response.rawHeaders[i].toLowerCase();
        if (key === 'content-type') rawTypes.push(codes(response.rawHeaders[i + 1]));
        if (key === 'content-disposition') rawDispositions.push(response.rawHeaders[i + 1]);
      }
      response.resume();
      response.on('end', () => resolve({status: response.statusCode,
        rawTypeCount: rawTypes.length, rawTypeCodes: rawTypes,
        dispositionHasPercent26: rawDispositions.some(value => value.includes('%26')),
        dispositionHasAmpRsct: rawDispositions.some(value => value.includes('&rsct='))}));
    });
    request.on('timeout', () => request.destroy());
    request.on('error', () => resolve({status: 0}));
  });
}

for (const entry of cases) {
  const name = `benign-combined-${process.env.GITHUB_RUN_ID}-${entry.label}${entry.suffix}`;
  const row = {label: entry.label};
  try {
    const created = await client.CreateArtifact({...ids, name, version: 7,
      mimeType: StringValue.create({value: entry.mime})});
    row.create = true;
    await new BlobClient(created.signedUploadUrl).getBlockBlobClient().uploadData(body,
      {blobHTTPHeaders: {blobContentType: 'application/x-blob-probe'}});
    row.upload = true;
    const finalized = await client.FinalizeArtifact({...ids, name,
      size: String(body.length), hash});
    row.finalize = Boolean(finalized.ok);
    const signed = (await client.GetSignedArtifactURL({...ids, name})).signedUrl;
    const query = new URL(signed);
    row.rsctCount = query.searchParams.getAll('rsct').length;
    row.rsctCodes = codes(query.searchParams.get('rsct') || '');
    row.fragment = Boolean(query.hash);
    row.rscdContainsSuffix = (query.searchParams.get('rscd') || '').includes(entry.suffix);
    row.read = await readRawHeaders(signed);
  } catch {
    row.stageError = row.create ? 'upload-finalize-sign' : 'create';
  }
  console.log('COMBINED-HEADER', JSON.stringify(row));
}
