// Bounded GitHub Actions raw artifact controls for Repo Cassette.
// Never prints runtime tokens, signed URLs, or sensitive content.
import { createHash } from 'node:crypto';

const token = process.env.ACTIONS_RUNTIME_TOKEN;
const results = process.env.ACTIONS_RESULTS_URL;
const ghToken = process.env.GITHUB_TOKEN;
const repo = process.env.GITHUB_REPOSITORY;
if (!token || !results || !ghToken || !repo) throw Error('Missing Actions context');
const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
const scope = claims.scp.split(' ').find(value => value.startsWith('Actions.Results:'));
if (!scope) throw Error('Missing Actions.Results scope');
const [, workflow_run_backend_id, workflow_job_run_backend_id] = scope.split(':');
const ids = { workflow_run_backend_id, workflow_job_run_backend_id };
const digest = body => createHash('sha256').update(body).digest('hex');

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

async function put(url, bytes, mime) {
  const response = await fetch(url, {
    method: 'PUT',
    headers: {
      'x-ms-version': '2020-10-02',
      'x-ms-blob-type': 'BlockBlob',
      'x-ms-blob-content-type': mime,
      'Content-Type': 'application/octet-stream',
    },
    body: bytes,
  });
  return response.status;
}

for (const [label, mime] of [['json', 'application/json'], ['text', 'text/plain']]) {
  const name = `rc-fixture-control-${process.env.GITHUB_RUN_ID}-${label}`;
  const created = await rpc('CreateArtifact', { ...ids, name, version: 7, mime_type: mime });
  const uploadUrl = created.signed_upload_url || created.signedUploadUrl;
  if (!uploadUrl) throw Error('No upload URL');
  const placeholder = Buffer.from(JSON.stringify({ probe: label }));
  const first = await put(uploadUrl, placeholder, mime);
  if (first !== 201) throw Error(`First upload HTTP ${first}`);
  const finalized = await rpc('FinalizeArtifact', { ...ids, name, size: String(placeholder.length) });
  const artifactId = finalized.artifact_id || finalized.artifactId;
  if (!artifactId) throw Error('No artifact ID');

  const repository = `${repo}/actions/artifacts/${artifactId}/zip`;
  const body = Buffer.from(JSON.stringify({
    full_name: repository,
    owner: { login: 'cassette', avatar_url: 'file:///proc/self/environ' },
    description: `Benign Repo Cassette ${label} control`,
    stargazers_count: 0,
  }));
  const second = await put(uploadUrl, body, mime);
  const api = await fetch(`https://api.github.com/repos/${repository}`, {
    redirect: 'manual',
    headers: {
      Authorization: `Bearer ${ghToken}`,
      Accept: 'application/vnd.github.v3+json',
      'User-Agent': 'repo-cassette-fixture-control',
    },
  });
  const location = api.headers.get('location');
  let finalStatus = null;
  let finalType = null;
  let bodyMatch = null;
  if (api.status === 302 && location) {
    const final = await fetch(location);
    finalStatus = final.status;
    finalType = final.headers.get('content-type');
    bodyMatch = Buffer.from(await final.arrayBuffer()).equals(body);
  }
  console.log('FIXTURE-CONTROL', JSON.stringify({
    label, artifactId, repository, expectedSha256: digest(body),
    overwriteStatus: second, restStatus: api.status,
    finalStatus, finalType, bodyMatch,
  }));
}

