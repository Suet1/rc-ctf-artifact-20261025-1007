// Bounded binary-protobuf MIME probe. Never prints bearer tokens or SAS URLs.
import { createHash } from 'node:crypto';

const runtimeToken = process.env.ACTIONS_RUNTIME_TOKEN;
const githubToken = process.env.GITHUB_TOKEN;
const resultBase = process.env.ACTIONS_RESULTS_URL;
if (!runtimeToken || !githubToken || !resultBase) throw new Error('Requires GitHub Actions');
const claims = JSON.parse(Buffer.from(runtimeToken.split('.')[1], 'base64url').toString());
const scope = claims.scp.split(' ').find(x => x.startsWith('Actions.Results:'));
if (!scope) throw new Error('Actions.Results scope missing');
const [, runId, jobId] = scope.split(':');
const service = new URL('/twirp/github.actions.results.api.v1.ArtifactService/', resultBase);
const payload = Buffer.from(JSON.stringify({ probe: 'binary-mime' }));
const digest = createHash('sha256').update(payload).digest('hex');

function varint(n) {
  let value = BigInt(n);
  const bytes = [];
  while (value > 127n) {
    bytes.push(Number(value & 127n) | 128);
    value >>= 7n;
  }
  bytes.push(Number(value));
  return Buffer.from(bytes);
}
function stringField(number, value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value, 'utf8');
  return Buffer.concat([varint(number * 8 + 2), varint(bytes.length), bytes]);
}
function intField(number, value) {
  return Buffer.concat([varint(number * 8), varint(value)]);
}
function readVarint(bytes, position) {
  let result = 0n;
  let shift = 0n;
  while (position.offset < bytes.length) {
    const byte = bytes[position.offset++];
    result |= BigInt(byte & 127) << shift;
    if (!(byte & 128)) return result;
    shift += 7n;
  }
  throw new Error('Short protobuf varint');
}
function createUrlFromProtobuf(bytes) {
  const position = { offset: 0 };
  while (position.offset < bytes.length) {
    const tag = Number(readVarint(bytes, position));
    const number = tag >> 3;
    const wire = tag & 7;
    if (wire === 0) {
      readVarint(bytes, position);
    } else if (wire === 2) {
      const length = Number(readVarint(bytes, position));
      const value = bytes.subarray(position.offset, position.offset + length);
      position.offset += length;
      if (number === 2) return value.toString('utf8');
    } else {
      throw new Error('Unexpected protobuf wire type');
    }
  }
  return '';
}

async function binaryCreate(name, mimeBytes) {
  const mime = stringField(1, mimeBytes);
  const body = Buffer.concat([
    stringField(1, runId), stringField(2, jobId), stringField(3, name),
    intField(5, 7), stringField(6, mime),
  ]);
  const response = await fetch(new URL('CreateArtifact', service), {
    method: 'POST',
    headers: { Authorization: `Bearer ${runtimeToken}`, 'Content-Type': 'application/protobuf' },
    body,
  });
  const raw = Buffer.from(await response.arrayBuffer());
  return { status: response.status, uploadUrl: response.ok ? createUrlFromProtobuf(raw) : '' };
}
async function rpc(method, fields) {
  const response = await fetch(new URL(method, service), {
    method: 'POST',
    headers: { Authorization: `Bearer ${runtimeToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ workflow_run_backend_id: runId, workflow_job_run_backend_id: jobId, ...fields }),
  });
  let data = {};
  try { data = await response.json(); } catch {}
  return { status: response.status, data };
}

const cases = [
  ['valid', Buffer.from('application/json')],
  ['raw85-leading', Buffer.concat([Buffer.from([0x85]), Buffer.from('application/json')])],
  ['raw85-trailing', Buffer.concat([Buffer.from('application/json'), Buffer.from([0x85])])],
  ['raw1c-leading', Buffer.concat([Buffer.from([0x1c]), Buffer.from('application/json')])],
  ['overlong85-leading', Buffer.concat([Buffer.from([0xc0, 0x85]), Buffer.from('application/json')])],
  ['utf8-nel-leading', Buffer.from('\u0085application/json')],
];

for (const [label, mimeBytes] of cases) {
  const report = { label, mimeHex: mimeBytes.toString('hex') };
  const name = `rc-binary-mime-${Date.now()}-${label}.json`;
  try {
    const created = await binaryCreate(name, mimeBytes);
    report.create = created.status;
    if (created.status !== 200 || !created.uploadUrl) {
      console.log('BINARY-MIME', JSON.stringify(report));
      continue;
    }
    const uploaded = await fetch(created.uploadUrl, {
      method: 'PUT',
      headers: {
        'x-ms-version': '2020-10-02',
        'x-ms-blob-type': 'BlockBlob',
        'x-ms-blob-content-type': '\u0085application/json',
        'Content-Type': 'application/json',
      },
      body: payload,
    });
    report.upload = uploaded.status;
    if (uploaded.status !== 201) {
      console.log('BINARY-MIME', JSON.stringify(report));
      continue;
    }
    const finalized = await rpc('FinalizeArtifact', { name, size: String(payload.length), hash: `sha256:${digest}` });
    report.finalize = finalized.status;
    const id = finalized.data.artifact_id || finalized.data.artifactId;
    report.artifactId = id ? String(id) : '';
    if (id) {
      const endpoint = `https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}/actions/artifacts/${id}/zip`;
      const first = await fetch(endpoint, {
        redirect: 'manual',
        headers: { Authorization: `Bearer ${githubToken}`, Accept: 'application/vnd.github.v3+json' },
      });
      report.rest = first.status;
      const location = first.headers.get('location');
      if (location) {
        const signed = new URL(location);
        report.rsct = signed.searchParams.get('rsct');
        const final = await fetch(signed);
        const type = final.headers.get('content-type') || '';
        report.final = final.status;
        report.typeCodePoints = [...type].map(c => c.codePointAt(0).toString(16));
      }
    }
  } catch (error) {
    report.error = String(error?.message || error).slice(0, 120);
  }
  console.log('BINARY-MIME', JSON.stringify(report));
}

