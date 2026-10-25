// Bounded REST route probe for an existing benign unzipped artifact.
// Never prints credentials or signed redirect URLs.
const repository = process.env.GITHUB_REPOSITORY;
const token = process.env.GITHUB_TOKEN;
if (!repository || !token) throw Error('Missing GitHub Actions context');
const artifact = '12600441753';
const routes = [
  `/actions/artifacts/${artifact}/raw`,
  `/actions/artifacts/${artifact}/file`,
  `/actions/artifacts/${artifact}/download`,
  `/actions/artifacts/${artifact}/unarchived`,
  `/actions/artifacts/${artifact}/json`,
  `/actions/artifacts/${artifact}/zip`,
  `/actions/artifacts/${artifact}?raw=1`,
  `/actions/artifacts/${artifact}?download=1`,
];
const asHex = value => Buffer.from(value || '', 'latin1').toString('hex');

for (const route of routes) {
  const label = route.replace(`/actions/artifacts/${artifact}`, '') || '(metadata)';
  try {
    const response = await fetch(`https://api.github.com/repos/${repository}${route}`, {
      redirect: 'manual',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github.v3+json',
        'User-Agent': 'repo-cassette-route-probe',
      },
      signal: AbortSignal.timeout(12000),
    });
    const row = { route: label, restStatus: response.status, restTypeHex: asHex(response.headers.get('content-type')) };
    const location = response.headers.get('location');
    if (response.status >= 300 && response.status < 400 && location) {
      const final = await fetch(location, { redirect: 'manual', signal: AbortSignal.timeout(12000) });
      row.finalStatus = final.status;
      row.finalTypeHex = asHex(final.headers.get('content-type'));
      row.finalBytes = (await final.arrayBuffer()).byteLength;
    }
    console.log('ARTIFACT-ROUTE', JSON.stringify(row));
  } catch (error) {
    console.log('ARTIFACT-ROUTE', JSON.stringify({ route: label, error: error.name || 'request-error' }));
  }
}

