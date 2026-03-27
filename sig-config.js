const { getStore } = require("@netlify/blobs");

const CORS = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers: CORS };
  }

  const store = getStore("sig-bot");

  if (event.httpMethod === "GET") {
    try {
      const cfg = await store.get("config", { type: "json" });
      return { statusCode: 200, headers: CORS, body: JSON.stringify(cfg || {}) };
    } catch (err) {
      return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: err.message }) };
    }
  }

  if (event.httpMethod === "POST") {
    try {
      const body = JSON.parse(event.body || "{}");
      let existing = {};
      try { existing = (await store.get("config", { type: "json" })) || {}; } catch (e) {}
      const newCfg = { ...existing, ...body, updatedAt: Date.now() };
      await store.setJSON("config", newCfg);
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, config: newCfg }) };
    } catch (err) {
      return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: err.message }) };
    }
  }

  return { statusCode: 405, body: "Method Not Allowed" };
};
