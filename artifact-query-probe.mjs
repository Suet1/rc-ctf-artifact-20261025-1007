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