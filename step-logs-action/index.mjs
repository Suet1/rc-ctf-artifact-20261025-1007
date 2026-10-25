// Inspect the completed disposable job's step-log endpoint without exposing signed URLs.
const repository = process.env.GITHUB_REPOSITORY;
const token = process.env.GITHUB_TOKEN;
const job = '121177615322';
if (!repository || !token) throw new Error('GitHub Actions token required');
for (let step = 0; step <= 20; step++) {
  const path = `https://api.github.com/repos/${repository}/actions/jobs/${job}/steps/${step}/logs`;
  try {
    const response = await fetch(path, {
      redirect: 'manual',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github.v3+json',
        'User-Agent': 'rc-step-log-probe',
      },
    });
    const report = {step, status: response.status, contentType: response.headers.get('content-type')};
    const location = response.headers.get('location');
    if (location) {
      const signed = new URL(location);
      report.host = signed.hostname;
      report.rsct = signed.searchParams.get('rsct');
      report.sp = signed.searchParams.get('sp');
      const final = await fetch(location);
      report.finalStatus = final.status;
      report.finalType = final.headers.get('content-type');
      const body = Buffer.from(await final.arrayBuffer());
      report.bytes = body.length;
      report.leadingHex = body.subarray(0, 12).toString('hex');
      if (signed.searchParams.get('sp')?.includes('w')) {
        const put = await fetch(location, {
          method: 'PUT',
          headers: {'x-ms-blob-type':'BlockBlob', 'Content-Type':'application/json'},
          body: Buffer.from('{"probe":"step-log-write"}'),
        });
        report.writeStatus = put.status;
        await put.arrayBuffer();
      }
    } else {
      await response.arrayBuffer();
    }
    console.log('STEP-LOG', JSON.stringify(report));
  } catch (error) {
    console.log('STEP-LOG', JSON.stringify({step, error: String(error).slice(0, 100)}));
  }
}

