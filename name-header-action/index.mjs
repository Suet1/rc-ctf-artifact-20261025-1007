// Bounded test of actual line separators in artifact names. No secrets or SAS URLs logged.
import https from 'node:https';
import { createHash } from 'node:crypto';

const token = process.env.ACTIONS_RUNTIME_TOKEN;
const results = process.env.ACTIONS_RESULTS_URL;
const githubToken = process.env.GITHUB_TOKEN;
if (!token || !results || !githubToken) throw new Error('GitHub Actions credentials missing');
const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
const scope = claims.scp.split(' ').find(x => x.startsWith('Actions.Results:'));
if (!scope) throw new Error('Actions.Results scope missing');
const [, runId, jobId] = scope.split(':');
const oddType = '\u0085application/json';
const payload = Buffer.from(JSON.stringify({ probe: 'name-header' }));
const digest = createHash('sha256').update(payload).digest('hex');
const stamp = Date.now();
const cases = [
  ['nel', `rc-hdr-${stamp}-nel\u0085.json`],
  ['cr', `rc-hdr-${stamp}-cr\rContent-Type: ${oddType}.json`],
  ['lf', `rc-hdr-${stamp}-lf\nContent-Type: ${oddType}.json`],
  ['crlf', `rc-hdr-${stamp}-crlf\r\nContent-Type: ${oddType}.json`],
];

async function rpc(method, fields) {
  const url = new URL(`/twirp/github.actions.results.api.v1.ArtifactService/${method}`, results);
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ workflow_run_backend_id: runId, workflow_job_run_backend_id: jobId, ...fields }),
  });
  const raw = await res.text();
  let data = {};
  try { data = JSON.parse(raw); } catch {}
  return { status: res.status, data, error: data.message || data.code || '' };
}

function rawHead(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, res => {
      const headers = res.rawHeaders;
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode, headers }));
    });
    req.on('error', reject);
    req.setTimeout(10000, () => req.destroy(new Error('timeout')));
  });
}

for (const version of [6, 7]) {
  for (const [label, name] of cases) {
    const report = { version, label };
    try {
      const ids = { name };
      const created = await rpc('CreateArtifact', {
        ...ids, version, mime_type: version === 7 ? 'application/json' : oddType,
      });
      report.create = created.status;
      if (created.status !== 200) {
        report.error = String(created.error).slice(0, 100);
        console.log('NAME-HEADER', JSON.stringify(report));
        continue;
      }
      const signedUpload = created.data.signed_upload_url || created.data.signedUploadUrl;
      const upload = await fetch(signedUpload, {
        method: 'PUT',
        headers: { 'x-ms-blob-type': 'BlockBlob', 'Content-Type': 'application/json' },
        body: payload,
      });
      report.upload = upload.status;
      if (upload.status !== 201) {
        console.log('NAME-HEADER', JSON.stringify(report));
        continue;
      }
      const finalized = await rpc('FinalizeArtifact', {
        ...ids, size: String(payload.length), hash: `sha256:${digest}`,
      });
      report.finalize = finalized.status;
      const artifactId = finalized.data.artifact_id || finalized.data.artifactId;
      if (!artifactId) {
        console.log('NAME-HEADER', JSON.stringify(report));
        continue;
      }
      report.artifactId = String(artifactId);
      const endpoint = `https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}/actions/artifacts/${artifactId}/zip`;
      const first = await fetch(endpoint, {
        redirect: 'manual',
        headers: { Authorization: `Bearer ${githubToken}`, Accept: 'application/vnd.github.v3+json' },
      });
      report.rest = first.status;
      const location = first.headers.get('location');
      if (location) {
        const signed = new URL(location);
        report.rsct = signed.searchParams.get('rsct');
        report.rscd = signed.searchParams.get('rscd');
        const final = await rawHead(signed);
        report.final = final.status;
        report.contentTypesHex = [];
        report.dispositionsHex = [];
        for (let i = 0; i < final.headers.length; i += 2) {
          const key = final.headers[i].toLowerCase();
          const valueHex = Buffer.from(final.headers[i + 1], 'latin1').toString('hex');
          if (key === 'content-type') report.contentTypesHex.push(valueHex);
          if (key === 'content-disposition') report.dispositionsHex.push(valueHex.slice(0, 160));
        }
      }
    } catch (error) {
      report.exception = String(error?.message || error).slice(0, 140);
    }
    console.log('NAME-HEADER', JSON.stringify(report));
  }
}

