const { getStore } = require("@netlify/blobs");

// ── Signal logic (mirrors frontend) ─────────────────────────────────────────

function calcEMA(prices, period) {
  if (prices.length < period) return null;
  const k = 2 / (period + 1);
  let ema = prices.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < prices.length; i++) ema = prices[i] * k + ema * (1 - k);
  return ema;
}

function calcRSI(closes, period = 14) {
  if (closes.length < period + 1) return null;
  const d = closes.slice(1).map((c, i) => c - closes[i]);
  let ag = 0, al = 0;
  for (let i = 0; i < period; i++) { if (d[i] > 0) ag += d[i]; else al += Math.abs(d[i]); }
  ag /= period; al /= period;
  for (let i = period; i < d.length; i++) {
    ag = (ag * (period - 1) + (d[i] > 0 ? d[i] : 0)) / period;
    al = (al * (period - 1) + (d[i] < 0 ? Math.abs(d[i]) : 0)) / period;
  }
  return al === 0 ? 100 : 100 - 100 / (1 + ag / al);
}

function countTags(klines, level, tolPct) {
  if (!level || !klines.length) return 0;
  const t = level * (tolPct / 100);
  return klines.filter(k => k.h >= level - t && k.l <= level + t).length;
}

function detectZones(klines, tolPct, minTags) {
  const pts = [];
  klines.forEach(k => { pts.push({ p: k.h, type: "res" }); pts.push({ p: k.l, type: "sup" }); });
  pts.sort((a, b) => a.p - b.p);
  const zones = [];
  for (const pt of pts) {
    const last = zones[zones.length - 1];
    if (last && Math.abs(pt.p - last.price) / last.price * 100 <= tolPct) {
      last.count++; last.price = (last.price + pt.price) / 2;
      pt.type === "res" ? last.highs++ : last.lows++;
    } else {
      zones.push({ price: pt.p, count: 1, highs: pt.type === "res" ? 1 : 0, lows: pt.type === "sup" ? 1 : 0 });
    }
  }
  zones.forEach(z => { z.type = z.highs >= z.lows ? "res" : "sup"; });
  return zones.filter(z => z.count >= minTags).sort((a, b) => b.count - a.count);
}

function autoPickZones(zones, curPrice) {
  const sup = zones.filter(z => z.price < curPrice).sort((a, b) => b.price - a.price).slice(0, 3).sort((a, b) => b.count - a.count);
  const res = zones.filter(z => z.price > curPrice).sort((a, b) => a.price - b.price).slice(0, 3).sort((a, b) => b.count - a.count);
  return { entry: sup[0] || null, target: res[0] || null };
}

function evalScore(klines, btcKlines, entryPrice, targetPrice, sl, cfg) {
  const closes = klines.map(k => k.c);
  const rsi = calcRSI(closes);
  const ema = calcEMA(closes, 20);
  const curPrice = closes[closes.length - 1];
  const lastCandle = klines[klines.length - 1];
  const avgVol = klines.slice(-20).reduce((a, k) => a + k.v, 0) / 20;
  const btcEma = btcKlines.length ? calcEMA(btcKlines, 20) : null;
  const btcPrice = btcKlines.length ? btcKlines[btcKlines.length - 1] : null;

  let score = 0;
  const results = {};

  const entryTags = countTags(klines, entryPrice, cfg.tolerance);
  if (entryPrice && entryTags >= cfg.minTags) score++;
  results.tagEntry = { pass: !!(entryPrice && entryTags >= cfg.minTags), val: entryTags + " tags" };

  const targetTags = countTags(klines, targetPrice, cfg.tolerance);
  if (targetPrice && targetTags >= cfg.minTags) score++;
  results.tagTarget = { pass: !!(targetPrice && targetTags >= cfg.minTags), val: targetTags + " tags" };

  const rsiPass = rsi !== null && rsi < 40;
  if (rsiPass) score++;
  results.rsi = { pass: rsiPass, val: rsi !== null ? rsi.toFixed(1) : "—" };

  const volSpike = lastCandle.v > avgVol * 1.5;
  if (volSpike) score++;
  results.volume = { pass: volSpike, val: (lastCandle.v / avgVol).toFixed(2) + "x" };

  const aboveEma = ema !== null && curPrice > ema;
  if (aboveEma) score++;
  results.ema = { pass: aboveEma, val: ema ? curPrice.toFixed(1) + " vs " + ema.toFixed(1) : "—" };

  const bullish = lastCandle.c > lastCandle.o;
  if (bullish) score++;
  results.candle = { pass: bullish, val: bullish ? "bullish" : "bearish" };

  const spread = entryPrice && targetPrice ? Math.abs(targetPrice - entryPrice) : 0;
  if (spread >= 10) score++;
  results.spread = { pass: spread >= 10, val: "$" + spread.toFixed(1) };

  if (sl) score++;
  results.stoploss = { pass: !!sl, val: sl ? "$" + sl : "not set" };

  const btcAboveEma = !!(btcEma && btcPrice && btcPrice > btcEma);
  if (btcAboveEma) score++;
  results.mkttrend = { pass: btcAboveEma, val: btcPrice ? (btcAboveEma ? "BTC above EMA" : "BTC below EMA") : "—" };

  // Time filter always passes on server
  score++;
  results.time = { pass: true, val: "server" };

  return { score, total: 10, results };
}

// ── Core bot logic ───────────────────────────────────────────────────────────

async function runBot() {
  const store = getStore("sig-bot");

  let cfg;
  try { cfg = await store.get("config", { type: "json" }); } catch (e) { cfg = null; }
  cfg = Object.assign({ symbol: "BTCUSDT", interval: "5m", minTags: 5, tolerance: 0.1, minScore: 7, running: false, sl: null }, cfg || {});

  if (!cfg.running) {
    console.log("[sig-bot] stopped, skipping.");
    return { statusCode: 200 };
  }

  const symbols = (cfg.symbols && cfg.symbols.length ? cfg.symbols : [cfg.symbol || "BTCUSDT"]).map(s => s.toUpperCase());
  const iv = cfg.interval || "5m";
  const ts = Date.now();

  // Load existing log
  let existing = null;
  try { existing = await store.get("results", { type: "json" }); } catch (e) {}
  const log = existing?.log || [];
  const symbolResults = existing?.symbols || {};

  // Fetch BTC klines once (used for mkttrend for all non-BTC tokens)
  let btcKlinesShared = [];
  try {
    const rb = await fetch("https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1h&limit=50");
    btcKlinesShared = rb.ok ? (await rb.json()).map(k => +k[4]) : [];
  } catch (e) {}

  for (const sym of symbols) {
    try {
      const r = await fetch(`https://api.binance.com/api/v3/klines?symbol=${sym}&interval=${iv}&limit=200`);
      if (!r.ok) throw new Error("Binance error " + r.status);
      const raw = await r.json();
      const klines = raw.map(k => ({ t: +k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] }));
      const btcKlines = sym === "BTCUSDT" ? klines.map(k => k.c) : btcKlinesShared;

      const zones = detectZones(klines, cfg.tolerance, cfg.minTags);
      const curPrice = klines[klines.length - 1].c;
      const { entry, target } = autoPickZones(zones, curPrice);
      const entryPrice = entry ? +entry.price.toFixed(1) : null;
      const targetPrice = target ? +target.price.toFixed(1) : null;

      const { score, total, results } = evalScore(klines, btcKlines, entryPrice, targetPrice, cfg.sl, cfg);
      const isReady = score >= cfg.minScore;

      symbolResults[sym] = { zones, curPrice, entry: entryPrice, target: targetPrice, interval: iv, score, total, criteria: results, loaded: true, ts };

      const logEntry = {
        t: ts,
        msg: `[${sym}] Score ${score}/${total} · $${curPrice.toFixed(2)} · ${zones.length} zones · ${isReady ? "🟢 READY" : "⏳ waiting"}`,
        isReady, isErr: false,
      };
      log.unshift(logEntry);
      console.log("[sig-bot]", logEntry.msg);
    } catch (err) {
      console.error(`[sig-bot] ${sym} error:`, err.message);
      log.unshift({ t: ts, msg: `[${sym}] Error: ${err.message}`, isErr: true, isReady: false });
    }
  }

  if (log.length > 200) log.length = 200;
  await store.setJSON("results", { symbols: symbolResults, log, updatedAt: ts });

  return { statusCode: 200 };
}

// ── Handler ───────────────────────────────────────────────────────────────────

exports.handler = async () => runBot();
