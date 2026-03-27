exports.handler = async function (event) {
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const apiKey = event.headers['x-mbx-apikey'];
  if (!apiKey) {
    return { statusCode: 400, body: JSON.stringify({ msg: 'Missing API key header' }) };
  }

  const path = event.queryStringParameters?.path;
  if (!path || !path.startsWith('/api/')) {
    return { statusCode: 400, body: JSON.stringify({ msg: 'Invalid path' }) };
  }

  // Only allow specific safe read-only Binance endpoints
  const ALLOWED_PATHS = ['/api/v3/account', '/api/v3/ticker/24hr'];
  if (!ALLOWED_PATHS.includes(path)) {
    return { statusCode: 403, body: JSON.stringify({ msg: 'Path not allowed' }) };
  }

  // Forward all query params except our internal 'path' param
  const forwardParams = { ...event.queryStringParameters };
  delete forwardParams.path;
  const qs = new URLSearchParams(forwardParams).toString();

  const url = `https://api.binance.com${path}${qs ? '?' + qs : ''}`;

  try {
    const resp = await fetch(url, {
      headers: { 'X-MBX-APIKEY': apiKey },
    });
    const body = await resp.text();
    return {
      statusCode: resp.status,
      headers: { 'Content-Type': 'application/json' },
      body,
    };
  } catch (err) {
    return {
      statusCode: 502,
      body: JSON.stringify({ msg: 'Proxy fetch failed: ' + err.message }),
    };
  }
};
