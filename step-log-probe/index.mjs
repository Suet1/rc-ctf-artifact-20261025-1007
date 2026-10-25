import https from 'node:https';
import fs from 'node:fs';

const token = process.env.ACTIONS_RUNTIME_TOKEN;
const base = process.env.ACTIONS_RESULTS_URL;
const repo = process.env.GITHUB_REPOSITORY;
const runId = process.env.GITHUB_RUN_ID;
const ghToken = process.env.GITHUB_TOKEN;
if (!token || !base || !repo || !runId || !ghToken) throw Error('missing Actions environment');
const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url'));
const scope = claims.scp.split(' ').find(s => s.startsWith('Actions.Results:'));
if (!scope) throw Error('missing results scope');
const [, workflow_run_backend_id, workflow_job_run_backend_id] = scope.split(':');

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
const typeCodepoints = r => Array.from(r?.headers?.['content-type'] || '', c => c.codePointAt(0).toString(16));
const api = path => request(`https://api.github.com/repos/${repo}${path}`, {
  headers: {authorization: `Bearer ${ghToken}`, accept: 'application/vnd.github.v3+json',
    'x-github-api-version': '2026-03-10', 'user-agent': 'cassette-step-log-probe'},
});
const receiver = (method, obj) => {
  const body = Buffer.from(JSON.stringify(obj));
  return request(new URL(`/twirp/results.services.receiver.Receiver/${method}`, base), {
    method: 'POST', headers: {authorization: `Bearer ${token}`, 'content-type': 'application/json', 'content-length': body.length},
  }, body);
};

let jobId;
for (let i = 0; i < 40 && !jobId; i++) {
  const jobs = await api(`/actions/runs/${runId}/jobs?filter=all`);
  if (jobs.status === 200) jobId = JSON.parse(jobs.body).jobs?.find(j => j.name === 'carrier')?.id;
  if (!jobId) await sleep(300);
}
if (!jobId) throw Error('job ID unavailable');

let target;
for (let i = 0; i < 40 && !target; i++) {
  const page = await request(`https://github.com/${repo}/actions/runs/${runId}/job/${jobId}`, {
    headers: {'user-agent': 'cassette-step-log-probe'},
  });
  const html = page.body.toString();
  for (const match of html.matchAll(/<check-step\s+([\s\S]*?)>/g)) {
    const attrs = match[1];
    if (attrs.match(/data-name="([^"]*)"/)?.[1] !== 'Carrier target') continue;
    const number = attrs.match(/data-number="(\d+)"/)?.[1];
    const backendId = attrs.match(/data-external-id="([0-9a-f-]{36})"/)?.[1];
    if (number && backendId) target = {number: Number(number), backendId};
  }
  if (!target) await sleep(300);
}
if (!target) {
  console.log('STEP-LOG-CARRIER', JSON.stringify({stage: 'step-discovery', found: false, jobId}));
  process.exit(0);
}
const identity = {workflow_run_backend_id, workflow_job_run_backend_id, step_backend_id: target.backendId};
const signedResponse = await receiver('GetStepLogsSignedBlobURL', identity);
if (signedResponse.status !== 200) {
  console.log('STEP-LOG-CARRIER', JSON.stringify({stage: 'GetStepLogsSignedBlobURL', status: signedResponse.status}));
  process.exit(0);
}
const signedUrl = JSON.parse(signedResponse.body).logs_url;
if (!signedUrl) throw Error('no signed URL');
const uploadUrl = new URL(signedUrl);
const uploadParams = uploadUrl.searchParams;
const candidates = [target.number - 1, target.number].filter(n => n >= 0);
async function checkPath(number) {
  const response = await api(`/actions/jobs/${jobId}/steps/${number}/logs`);
  const location = response.status === 302 && response.headers.location ? new URL(response.headers.location) : null;
  return {number, response, location,
    sameBlob: Boolean(location && location.host === uploadUrl.host && location.pathname === uploadUrl.pathname)};
}
const before = [];
for (const number of candidates) before.push(await checkPath(number));
let stepNumber = before.find(x => x.sameBlob)?.number ?? target.number - 1;
const bodyFor = number => Buffer.from(JSON.stringify({
  full_name: `${repo}/actions/jobs/${jobId}/steps/${number}/logs`,
  owner: {login: 'cassette', avatar_url: 'https://github.com/favicon.ico'},
  description: 'Repo Cassette step log probe', stargazers_count: 0,
}));
const appendUrl = new URL(signedUrl);
appendUrl.searchParams.set('comp', 'appendblock');
async function overwrite(body) {
  const initialize = await request(signedUrl, {method: 'PUT', headers: {
    'x-ms-version': '2023-11-03', 'x-ms-blob-type': 'AppendBlob',
    'content-type': '\x85application/json', 'content-length': 0,
  }});
  const append = initialize.status === 201 ? await request(appendUrl, {method: 'PUT', headers: {
    'x-ms-version': '2023-11-03', 'content-length': body.length,
    'x-ms-blob-condition-appendpos': '0',
  }}, body) : null;
  return {initializeStatus: initialize.status, appendStatus: append?.status};
}
let write = await overwrite(bodyFor(stepNumber));
const metadata = await receiver('CreateStepLogsMetadata', {
  ...identity, uploaded_at: new Date().toISOString(), line_count: 1,
});
const after = [];
for (const number of candidates) after.push(await checkPath(number));
const actual = after.find(x => x.sameBlob);
if (actual && actual.number !== stepNumber) {
  stepNumber = actual.number;
  write = await overwrite(bodyFor(stepNumber));
}
fs.appendFileSync(process.env.GITHUB_OUTPUT, `job_id=${jobId}\nstep_number=${stepNumber}\n`);
const repository = `${repo}/actions/jobs/${jobId}/steps/${stepNumber}/logs`;
const expected = bodyFor(stepNumber);
const selected = after.find(x => x.number === stepNumber);
const rest = selected?.response;
const location = selected?.location;
const blob = location ? await request(location) : null;
console.log('STEP-LOG-CARRIER', JSON.stringify({stage: 'complete', jobId, htmlNumber: target.number, stepNumber,
  repository, permissions: uploadParams.get('sp'), uploadHasRsct: uploadParams.has('rsct'),
  before: before.map(x => ({number: x.number, status: x.response.status, sameBlob: x.sameBlob})),
  write, metadataStatus: metadata.status,
  after: after.map(x => ({number: x.number, status: x.response.status, sameBlob: x.sameBlob})),
  restStatus: rest?.status,
  restHasRsct: location?.searchParams.has('rsct') || false,
  blob: blob && {status: blob.status, typeCodepoints: typeCodepoints(blob), bodyMatch: blob.body.equals(expected)},
}));
