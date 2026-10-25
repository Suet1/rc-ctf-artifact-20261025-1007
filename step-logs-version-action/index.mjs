// Probe documented step log API versions without printing tokens or signed URLs.
const token = process.env.GITHUB_TOKEN;
const repository = process.env.GITHUB_REPOSITORY;
const job = '121177615322';
for (const version of ['2026-03-10', '2022-11-28']) {
  for (const step of [0, 1, 2, 3]) {
    const response = await fetch(`https://api.github.com/repos/${repository}/actions/jobs/${job}/steps/${step}/logs`, {
      redirect: 'manual',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github.v3+json',
        'X-GitHub-Api-Version': version,
        'User-Agent': 'rc-step-log-version-probe',
      },
    });
    const report = {version, step, status: response.status,
      type: response.headers.get('content-type')};
    const location = response.headers.get('location');
    if (location) {
      const signed = new URL(location);
      report.rsct = signed.searchParams.get('rsct');
      report.sp = signed.searchParams.get('sp');
      const final = await fetch(location);
      report.finalStatus = final.status;
      report.finalType = final.headers.get('content-type');
      report.bytes = (await final.arrayBuffer()).byteLength;
    } else {
      const body = await response.text();
      report.error = body.slice(0, 100);
    }
    console.log('STEP-LOG-VERSION', JSON.stringify(report));
  }
}

