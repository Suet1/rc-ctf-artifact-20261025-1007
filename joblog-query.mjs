// Bounded GitHub job-log redirect query probe. Never prints tokens or SAS URLs.
import https from 'node:https';

const repository = process.env.GITHUB_REPOSITORY;
const token = process.env.GITHUB_TOKEN;
if (!repository || !token) throw Error('Missing GitHub Actions context');
const job = '121177615322';
const base = `https://api.github.com/repos/${repository}/actions/jobs/${job}/logs`;
const variants = [
  ['plain', ''],
  ['rsct', '?rsct=%85application%2Fjson'],
  ['response-content-type', '?response-content-type=%85application%2Fjson'],
  ['api-version', '?api-version=2012-02-12'],
];
const hex = value => Buffer.from(value || '', 'latin1').toString('hex');

for (const [label, query] of variants) {
  try {
    const response = await fetch(base + query, {
      redirect: 'manual',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github.v3+json',
        'User-Agent': 'repo-cassette-joblog-query-probe',
      },
      signal: AbortSignal.timeout(12000),
    });
    const row = { label, restStatus: response.status };
    const location = response.headers.get('location');
    if (response.status === 302 && location) {
      const signed = new URL(location);
      row.redirectKeys = [...signed.searchParams.keys()].sort();
      row.redirectRsctHex = hex(signed.searchParams.get('rsct'));
      row.redirectApiVersion = signed.searchParams.get('api-version');
      row.redirectResponseContentTypeHex = hex(signed.searchParams.get('response-content-type'));
      const final = await new Promise((resolve, reject) => {
        const request = https.get(signed, { timeout: 12000 }, incoming => {
          const types = [];
          for (let index = 0; index < incoming.rawHeaders.length; index += 2) {
            if (incoming.rawHeaders[index].toLowerCase() === 'content-type') {
              types.push(hex(incoming.rawHeaders[index + 1]));
            }
          }
          incoming.resume();
          incoming.on('end', () => resolve({ status: incoming.statusCode, types }));
        });
        request.on('timeout', () => request.destroy(Error('Download timeout')));
        request.on('error', reject);
      });
      row.finalStatus = final.status;
      row.finalTypesHex = final.types;
    }
    console.log('JOBLOG-QUERY', JSON.stringify(row));
  } catch (error) {
    console.log('JOBLOG-QUERY', JSON.stringify({ label, error: error.code || error.name }));
  }
}

