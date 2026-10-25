// Bounded release-asset media probe in this disposable repository.
// Never prints credentials, upload URLs, redirect URLs, or response bodies.
import https from 'node:https';
import { createHash } from 'node:crypto';

const repository = process.env.GITHUB_REPOSITORY;
const token = process.env.GITHUB_TOKEN;
const run = process.env.GITHUB_RUN_ID;
if (!repository || !token || !run) throw Error('Missing GitHub Actions context');
const prefix = `https://api.github.com/repos/${repository}`;
const hex = value => Buffer.from(value || '', 'latin1').toString('hex');

function request(url, headers, method = 'GET', body = null) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, { method, headers, timeout: 12000 }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({
        status: response.statusCode,
        headers: response.headers,
        rawHeaders: response.rawHeaders,
        body: Buffer.concat(chunks),
      }));
    });
    req.on('timeout', () => req.destroy(Error('HTTP timeout')));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

const common = {
  authorization: `Bearer ${token}`,
  accept: 'application/vnd.github.v3+json',
  'user-agent': 'repo-cassette-release-probe',
};
const releaseBody = Buffer.from(JSON.stringify({
  tag_name: `rc-release-probe-${run}`,
  name: `Repo Cassette probe ${run}`,
  draft: false,
  prerelease: true,
}));
const release = await request(`${prefix}/releases`, {
  ...common, 'content-type': 'application/json', 'content-length': releaseBody.length,
}, 'POST', releaseBody);
if (release.status !== 201) {
  console.log('RELEASE-PROBE', JSON.stringify({ stage: 'create', status: release.status }));
  process.exit(0);
}
const releaseId = JSON.parse(release.body).id;

const cases = [
  ['vendor', 'application/vnd.github.v3+json'],
];
for (const [label, mime] of cases) {
  const payload = Buffer.from(JSON.stringify({ probe: label, run }));
  let uploaded;
  try {
    const url = `https://uploads.github.com/repos/${repository}/releases/${releaseId}/assets?name=rc-${run}-${label}.json`;
    uploaded = await request(url, {
      ...common,
      'content-type': mime,
      'content-length': payload.length,
    }, 'POST', payload);
  } catch (error) {
    console.log('RELEASE-PROBE', JSON.stringify({ label, stage: 'upload', error: error.code || error.name }));
    continue;
  }
  if (uploaded.status !== 201) {
    console.log('RELEASE-PROBE', JSON.stringify({ label, stage: 'upload', status: uploaded.status }));
    continue;
  }
  const assetId = JSON.parse(uploaded.body).id;
  for (const accept of ['application/vnd.github.v3+json', 'application/octet-stream']) {
    const response = await request(`${prefix}/releases/assets/${assetId}`, { ...common, accept });
    const row = {
      label, assetId, accept,
      restStatus: response.status,
      restTypeHex: hex(response.headers['content-type']),
      restBodyMatch: response.body.equals(payload),
    };
    if (response.status >= 300 && response.status < 400 && response.headers.location) {
      const final = await request(response.headers.location, { 'user-agent': 'repo-cassette-release-probe' });
      row.finalStatus = final.status;
      row.finalTypeHex = hex(final.headers['content-type']);
      row.finalBodyMatch = final.body.equals(payload);
      row.finalTypeCount = final.rawHeaders.filter((_, index) => index % 2 === 0)
        .filter(name => name.toLowerCase() === 'content-type').length;
    }
    console.log('RELEASE-PROBE', JSON.stringify(row));
  }
}

