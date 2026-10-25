import https from 'node:https';
import crypto from 'node:crypto';

const token = process.env.ACTIONS_RUNTIME_TOKEN;
const base = process.env.ACTIONS_RESULTS_URL;
const repo = process.env.GITHUB_REPOSITORY;
const runId = process.env.GITHUB_RUN_ID;
const ghToken = process.env.GITHUB_TOKEN;
if (!token || !base || !repo || !runId || !ghToken) throw Error('missing Actions environment');
const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url'));
const scope = claims.scp.split(' ').find(s => s.startsWith('Actions.Results:'));
if (!scope) throw Error('missing results scope');
const [, workflowRunId] = scope.split(':');

const request = (url, options = {}, body) => new Promise((resolve, reject) => {
  const req = https.request(url, options, res => {
    const chunks = [];
    res.on('data', x => chunks.push(x));
    res.on('end', () => resolve({status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks)}));
  });
  req.setTimeout(20000, () => req.destroy(Error('timeout')));
  req.on('error', reject);
  if (body !== undefined) req.write(body);
  req.end();
});
const typeHex = r => Buffer.from(r?.headers?.['content-type'] || '', 'latin1').toString('hex');
const typeCodepoints = r => Array.from(r?.headers?.['content-type'] || '', c => c.codePointAt(0).toString(16));
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const rpc = (method, obj) => {
  const body = Buffer.from(JSON.stringify(obj));
  return request(new URL(`/twirp/github.actions.results.api.v1.ArtifactService/${method}`, base), {
    method: 'POST', headers: {authorization: `Bearer ${token}`, 'content-type': 'application/json', 'content-length': body.length},
  }, body);
};
const api = path => request(`https://api.github.com/repos/${repo}${path}`, {
  headers: {authorization: `Bearer ${ghToken}`, accept: 'application/vnd.github.v3+json', 'user-agent': 'cassette-migrate-probe'},
});

const name = `migrate-probe-${runId}`;
const created = await rpc('MigrateArtifact', {workflow_run_backend_id: workflowRunId, name});
if (created.status !== 200) {
  console.log('MIGRATE-PROBE', JSON.stringify({stage: 'MigrateArtifact', status: created.status}));
  process.exit(0);
}
const uploadUrl = JSON.parse(created.body).signed_upload_url;
if (!uploadUrl) {
  console.log('MIGRATE-PROBE', JSON.stringify({stage: 'MigrateArtifact', status: 200, hasUploadUrl: false}));
  process.exit(0);
}
const uploadParams = new URL(uploadUrl).searchParams;
const placeholder = Buffer.from('{}');
const initial = await request(uploadUrl, {method: 'PUT', headers: {
  'x-ms-version': '2023-11-03', 'x-ms-blob-type': 'BlockBlob',
  'content-type': 'application/json', 'content-length': placeholder.length,
}}, placeholder);
if (initial.status !== 201) {
  console.log('MIGRATE-PROBE', JSON.stringify({stage: 'initial upload', status: initial.status, permissions: uploadParams.get('sp')}));
  process.exit(0);
}
const finalized = await rpc('FinalizeMigratedArtifact', {
  workflow_run_backend_id: workflowRunId, name, size: String(placeholder.length),
});
if (finalized.status !== 200) {
  console.log('MIGRATE-PROBE', JSON.stringify({stage: 'FinalizeMigratedArtifact', status: finalized.status}));
  process.exit(0);
}
const artifactId = JSON.parse(finalized.body).artifact_id;
if (!artifactId) {
  console.log('MIGRATE-PROBE', JSON.stringify({stage: 'FinalizeMigratedArtifact', status: 200, hasArtifactId: false}));
  process.exit(0);
}
const repository = `${repo}/actions/artifacts/${artifactId}/zip`;
const expected = Buffer.from(JSON.stringify({
  full_name: repository,
  owner: {login: 'cassette', avatar_url: 'https://github.com/favicon.ico'},
  description: 'Repo Cassette migrated artifact probe',
  stargazers_count: 0,
}));
const changed = await request(uploadUrl, {method: 'PUT', headers: {
  'x-ms-version': '2023-11-03', 'x-ms-blob-type': 'BlockBlob',
  'content-type': '\x85application/json', 'content-length': expected.length,
}}, expected);
const rest = await api(`/actions/artifacts/${artifactId}/zip`);
const location = rest.status === 302 && rest.headers.location ? new URL(rest.headers.location) : null;
const final = location ? await request(location) : null;
const versioned = [];
const githubVersioned = [];
if (location) {
  for (const version of ['2012-02-12', '2013-08-15', '2014-02-14', '2015-02-21']) {
    const oldUrl = new URL(location);
    oldUrl.searchParams.set('api-version', version);
    const old = await request(oldUrl);
    versioned.push({version, status: old.status, typeHex: typeHex(old), typeCodepoints: typeCodepoints(old), bodyMatch: old.body.equals(expected)});
    const routed = await api(`/actions/artifacts/${artifactId}/zip?api-version=${version}`);
    const routedUrl = routed.status === 302 && routed.headers.location ? new URL(routed.headers.location) : null;
    const blob = routedUrl ? await request(routedUrl) : null;
    githubVersioned.push({version, status: routed.status, hasApiVersion: routedUrl?.searchParams.has('api-version') || false,
      hasRsct: routedUrl?.searchParams.has('rsct') || false, blobStatus: blob?.status,
      typeHex: typeHex(blob), bodyMatch: blob?.body.equals(expected)});
  }
}
console.log('MIGRATE-PROBE', JSON.stringify({stage: 'complete', artifactId, repository,
  expectedSha: sha(expected), permissions: uploadParams.get('sp'),
  uploadHasRsct: uploadParams.has('rsct'), changedStatus: changed.status,
  restStatus: rest.status, restHasRsct: location?.searchParams.has('rsct') || false,
  final: final && {status: final.status, typeHex: typeHex(final), typeCodepoints: typeCodepoints(final), bodyMatch: final.body.equals(expected)},
  versioned, githubVersioned,
}));
