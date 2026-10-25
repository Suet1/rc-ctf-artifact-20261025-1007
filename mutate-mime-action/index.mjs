// Bounded probe of post-creation MIME changes for a disposable Actions artifact.
// Never prints runtime credentials or signed storage URLs.
import { createHash } from 'node:crypto';

const runtimeToken = process.env.ACTIONS_RUNTIME_TOKEN;
const resultsUrl = process.env.ACTIONS_RESULTS_URL;
const githubToken = process.env.GITHUB_TOKEN;
if (!runtimeToken || !resultsUrl || !githubToken) throw new Error('Requires GitHub Actions');
const claims = JSON.parse(Buffer.from(runtimeToken.split('.')[1], 'base64url').toString());
const scope = claims.scp.split(' ').find(value => value.startsWith('Actions.Results:'));
if (!scope) throw new Error('Missing Actions.Results scope');
const [, run, job] = scope.split(':');
const name = `rc-mime-mutate-${Date.now()}.json`;
const ids = { workflow_run_backend_id: run, workflow_job_run_backend_id: job, name };
const oddType = '\u0085application/json';
const payload = Buffer.from(JSON.stringify({ probe: 'post-create-mime', timestamp: Date.now() }));

async function rpc(method, extra) {
  const url = new URL(`/twirp/github.actions.results.api.v1.ArtifactService/${method}`, resultsUrl);
  const response = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${runtimeToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...ids, ...extra }),
  });
  const raw = await response.text();
  let parsed = {};
  try { parsed = JSON.parse(raw); } catch {}
  return { status: response.status, parsed, errorCode: parsed.code || parsed.message || '' };
}

const created = await rpc('CreateArtifact', { version: 7, mime_type: 'application/json' });
if (created.status !== 200) throw new Error(`CreateArtifact HTTP ${created.status}`);
const uploadUrl = created.parsed.signed_upload_url || created.parsed.signedUploadUrl;
if (!uploadUrl) throw new Error('Missing signed upload URL');
const upload = await fetch(uploadUrl, {
  method: 'PUT',
  headers: {
    'x-ms-version': '2020-10-02',
    'x-ms-blob-type': 'BlockBlob',
    'x-ms-blob-content-type': 'application/json',
    'Content-Type': 'application/json',
  },
  body: payload,
});
console.log('MUTATE upload', upload.status);
if (upload.status !== 201) throw new Error('Blob upload failed');
const digest = createHash('sha256').update(payload).digest('hex');
const finalized = await rpc('FinalizeArtifact', {
  size: String(payload.length), hash: `sha256:${digest}`,
});
const artifactId = finalized.parsed.artifact_id || finalized.parsed.artifactId;
if (finalized.status !== 200 || !artifactId) throw new Error(`FinalizeArtifact HTTP ${finalized.status}`);
console.log('MUTATE artifactId', artifactId);

const alter = new URL(uploadUrl);
alter.searchParams.set('comp', 'properties');
const property = await fetch(alter, {
  method: 'PUT',
  headers: { 'x-ms-version': '2020-10-02', 'x-ms-blob-content-type': oddType },
});
console.log('MUTATE blob-properties', property.status);

const apiBase = `https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}/actions/artifacts/${artifactId}`;
const patch = await fetch(apiBase, {
  method: 'PATCH',
  headers: {
    Authorization: `Bearer ${githubToken}`,
    Accept: 'application/vnd.github.v3+json',
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({ mime_type: oddType }),
});
console.log('MUTATE rest-patch', patch.status);
await patch.arrayBuffer();

for (const method of ['UpdateArtifact', 'SetArtifactMimeType', 'UpdateArtifactMetadata']) {
  const result = await rpc(method, { mime_type: oddType, artifact_id: String(artifactId) });
  console.log('MUTATE rpc', method, result.status, String(result.errorCode).slice(0, 90));
}

const rest = await fetch(`${apiBase}/zip`, {
  redirect: 'manual',
  headers: { Authorization: `Bearer ${githubToken}`, Accept: 'application/vnd.github.v3+json' },
});
const location = rest.headers.get('location');
console.log('MUTATE rest-download', rest.status);
if (location) {
  const signed = new URL(location);
  console.log('MUTATE rsct', signed.searchParams.get('rsct'));
  const final = await fetch(signed);
  const contentType = final.headers.get('content-type') || '';
  const received = Buffer.from(await final.arrayBuffer());
  console.log('MUTATE final', JSON.stringify({
    status: final.status,
    typeCodePoints: [...contentType].map(c => c.codePointAt(0).toString(16)),
    bodyMatch: createHash('sha256').update(received).digest('hex') === digest,
  }));
}

