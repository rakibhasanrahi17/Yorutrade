const { getStore } = require("@netlify/blobs");

const CORS = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
};

exports.handler = async () => {
  try {
    const store = getStore("sig-bot");
    const results = await store.get("results", { type: "json" });
    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify(results || { empty: true }),
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: CORS,
      body: JSON.stringify({ error: err.message }),
    };
  }
};
