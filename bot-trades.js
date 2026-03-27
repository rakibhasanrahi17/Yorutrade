const { getStore } = require('@netlify/blobs');

const CORS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS };

  const store = getStore('sig-bot');

  if (event.httpMethod === 'GET') {
    try {
      const results = (await store.get('results', { type: 'json' })) || {};
      return { statusCode: 200, headers: CORS, body: JSON.stringify(results.trades || []) };
    } catch (e) {
      return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: e.message }) };
    }
  }

  if (event.httpMethod === 'POST') {
    try {
      const { action, id, price } = JSON.parse(event.body || '{}');
      const results = (await store.get('results', { type: 'json' })) || {};
      const trades = results.trades || [];
      if (action === 'close' && id) {
        const t = trades.find(t => t.id === id);
        if (t) { t.status = 'closed'; t.closedAt = Date.now(); t.closePrice = price || null; }
      }
      results.trades = trades;
      await store.setJSON('results', results);
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true }) };
    } catch (e) {
      return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: e.message }) };
    }
  }

  return { statusCode: 405, body: 'Method Not Allowed' };
};
