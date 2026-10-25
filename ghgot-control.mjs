// Exact gh-got@12 responseType:buffer control for staged CTF artifacts.
// Never prints credentials, redirect URLs, or response bodies.
import { createHash } from 'node:crypto';
const { default: ghGot } = await import('gh-got');
const repository = process.env.GITHUB_REPOSITORY;
if (!repository || !process.env.GITHUB_TOKEN) throw Error('Missing GitHub Actions context');
const cases = [
  ['json-benign', '12601540805'],
  ['text-benign', '12601276134'],
  ['json-file', '12601431298'],
  ['text-file', '12601321375'],
];
for (const [label, id] of cases) {
  try {
    const response = await ghGot(`repos/${repository}/actions/artifacts/${id}/zip`, {
      responseType: 'buffer', timeout: { request: 6000 }, retry: { limit: 0 },
    });
    const body = Buffer.from(response.body);
    console.log('GHGOT-CONTROL', JSON.stringify({
      label, artifactId: id, status: response.statusCode,
      contentType: response.headers['content-type'] || null,
      sha256: createHash('sha256').update(body).digest('hex'),
      bytes: body.length,
    }));
  } catch (error) {
    console.log('GHGOT-CONTROL', JSON.stringify({
      label, artifactId: id, error: error.name || 'request-error',
      status: error.response?.statusCode || null,
    }));
  }
}

