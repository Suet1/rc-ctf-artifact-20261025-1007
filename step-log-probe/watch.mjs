import https from 'node:https';

const repo = process.env.GITHUB_REPOSITORY;
const jobId = process.env.CARRIER_JOB_ID;
const stepNumber = process.env.CARRIER_STEP_NUMBER;
const token = process.env.GITHUB_TOKEN;
if (!repo || !jobId || !stepNumber || !token) throw Error('missing watcher inputs');
const expected = Buffer.from(JSON.stringify({
  full_name: `${repo}/actions/jobs/${jobId}/steps/${stepNumber}/logs`,
  owner: {login: 'cassette', avatar_url: 'https://github.com/favicon.ico'},
  description: 'Repo Cassette step log probe', stargazers_count: 0,
}));
const request = (url, options = {}) => new Promise((resolve, reject) => {
  const req = https.request(url, options, res => {
    const chunks = [];
    res.on('data', x => chunks.push(x));
    res.on('end', () => resolve({status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks)}));
  });
  req.setTimeout(20000, () => req.destroy(Error('timeout')));
  req.on('error', reject);
  req.end();
});
const sleep = ms => new Promise(r => setTimeout(r, ms));
let summary;
for (let i = 0; i < 15; i++) {
  const rest = await request(`https://api.github.com/repos/${repo}/actions/jobs/${jobId}/steps/${stepNumber}/logs`, {
    headers: {authorization: `Bearer ${token}`, accept: 'application/vnd.github.v3+json',
      'x-github-api-version': '2026-03-10', 'user-agent': 'cassette-step-log-watcher'},
  });
  const location = rest.status === 302 && rest.headers.location ? new URL(rest.headers.location) : null;
  const blob = location ? await request(location) : null;
  summary = {jobId, stepNumber, restStatus: rest.status,
    restHasRsct: location?.searchParams.has('rsct') || false,
    blob: blob && {status: blob.status,
      typeCodepoints: Array.from(blob.headers['content-type'] || '', c => c.codePointAt(0).toString(16)),
      bodyMatch: blob.body.equals(expected)},
  };
  if (location) break;
  await sleep(2000);
}
console.log('STEP-LOG-WATCH', JSON.stringify(summary));
