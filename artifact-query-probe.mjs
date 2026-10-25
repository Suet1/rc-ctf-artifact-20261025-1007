// Bounded artifact redirect query probe. Never prints tokens or signed URLs.
const repository = process.env.GITHUB_REPOSITORY;
const token = process.env.GITHUB_TOKEN;
if (repository !== 'Suet1/rc-ctf-artifact-20261025-1007' || !token) throw new Error('Unexpected repository or missing runner token');
const api = 'https://api.github.com/repos/' + repository;
const headers = {
  Authorization: 'Bearer ' + token,
  Accept: 'application/vnd.github.v3+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent': 'repo-cassette-query-probe',
};
const artifactId = '12598031583';
const target = api + '/actions/artifacts/' + artifactId + '/zip';
const odd = encodeURIComponent('\u0085application/json');
const cases = [
  ['baseline', ''],
  ['rsct', '?rsct=' + odd],
  ['response-content-type', '?response-content-type=' + odd],
  ['content_type', '?content_type=' + odd],
  ['mime_type', '?mime_type=' + odd],
  ['api-version', '?api-version=2012-02-12'],
  ['format', '?format=raw'],
  ['archive_format', '?archive_format=raw'],
  ['download_format', '?download_format=raw'],
];
for (const [label, suffix] of cases) {
  try {
    const response = await fetch(target + suffix, { headers, redirect: 'manual' });
    const location = response.headers.get('location');
    const redirect = location ? new URL(location) : null;
    const rsct = redirect?.searchParams.get('rsct') || '';
    console.log('QUERY-PROBE ' + JSON.stringify({
      label, status: response.status, responseType: response.headers.get('content-type'),
      redirectHost: redirect?.hostname || null,
      rsctCodePoints: [...rsct].map(c => c.codePointAt(0).toString(16)),
      hasApiVersion: redirect?.searchParams.has('api-version') || false,
    }));
  } catch (error) {
    console.log('QUERY-PROBE ' + JSON.stringify({ label, error: String(error).slice(0, 120) }));
  }
}

// Check whether a rejected v7 MIME leaves a ghost row that influences later creates.
const runtimeToken = process.env.ACTIONS_RUNTIME_TOKEN;
const resultsUrl = process.env.ACTIONS_RESULTS_URL;
if (!runtimeToken || !resultsUrl) {
  console.log('GHOST-PROBE ' + JSON.stringify({ missingRuntime: true }));
} else {
  const claims = JSON.parse(Buffer.from(runtimeToken.split('.')[1], 'base64url').toString());
  const scope = claims.scp.split(' ').find(s => s.startsWith('Actions.Results:'));
  if (!scope) throw new Error('Missing Actions.Results scope');
  const [, runBackendId, jobBackendId] = scope.split(':');
  const ids = { workflow_run_backend_id: runBackendId, workflow_job_run_backend_id: jobBackendId };
  async function rpc(method, body) {
    const url = new URL('/twirp/github.actions.results.api.v1.ArtifactService/' + method, resultsUrl);
    const response = await fetch(url, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + runtimeToken, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await response.json();
    return { status: response.status, data };
  }
  const name = 'rc-ghost-' + Date.now();
  const invalid = await rpc('CreateArtifact', { ...ids, name, version: 7, mime_type: '\u0085application/json' });
  const ghost = await rpc('GetSignedArtifactURL', { ...ids, name });
  const valid = await rpc('CreateArtifact', { ...ids, name, version: 7, mime_type: 'application/json' });
  console.log('GHOST-PROBE ' + JSON.stringify({
    invalidCreateStatus: invalid.status,
    invalidCode: invalid.data.code || null,
    ghostSignedStatus: ghost.status,
    ghostCode: ghost.data.code || null,
    validCreateStatus: valid.status,
    validCode: valid.data.code || null,
  }));
}
