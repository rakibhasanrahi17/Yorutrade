const { schedule } = require('@netlify/functions');
const { getStore } = require('@netlify/blobs');
const crypto = require('crypto');

const TOKENS = [
  'BTCUSDT','ETHUSDT','BNBUSDT','SOLUSDT','XRPUSDT',
  'ADAUSDT','AVAXUSDT','DOGEUSDT','TRXUSDT','DOTUSDT',
  'MATICUSDT','LINKUSDT','SHIBUSDT','LTCUSDT','UNIUSDT',
  'ATOMUSDT','XLMUSDT','BCHUSDT','ETCUSDT','APTUSDT',
  'NEARUSDT','ARBUSDT','OPUSDT','INJUSDT','SUIUSDT',
  'SEIUSDT','PEPEUSDT','FTMUSDT','AAVEUSDT','MKRUSDT',
  'SNXUSDT','COMPUSDT','CRVUSDT','LDOUSDT','GRTUSDT',
  'SANDUSDT','MANAUSDT','CHZUSDT','DYDXUSDT','IMXUSDT',
  'RUNEUSDT','ALGOUSDT','VETUSDT','FETUSDT','ENJUSDT',
  'WLDUSDT','HBARUSDT','FILUSDT','ICPUSDT','BLURUSDT'
];

const BATCH = 5;
const BASE = 'https://api.binance.com';

// ── Indicators ────────────────────────────────────────────────────────────────

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

function detectZones(klines, tolPct, minTags) {
  const pts = [];
  klines.forEach(k => { pts.push(k.h); pts.push(k.l); });
  pts.sort((a, b) => a - b);
  const zones = [];
  for (const p of pts) {
    const last = zones[zones.length - 1];
    if (last && Math.abs(p - last.price) / last.price * 100 <= tolPct) {
      last.count++;
      last.price = (last.price + p) / 2;
    } else {
      zones.push({ price: p, count: 1 });
    }
  }
  return zones.filter(z => z.count >= minTags).sort((a, b) => b.count - a.count);
}

function autoPickZones(zones, curPrice) {
  const sup = zones.filter(z => z.price < curPrice).sort((a, b) => b.price - a.price).slice(0, 3).sort((a, b) => b.count - a.count);
  const res = zones.filter(z => z.price > curPrice).sort((a, b) => a.price - b.price).slice(0, 3).sort((a, b) => b.count - a.count);
  return { entry: sup[0] || null, target: res[0] || null };
}

// ── Criteria Evaluation ───────────────────────────────────────────────────────

function evalCriteria(klines, btcCloses, cfg) {
  const closes = klines.map(k => k.c);
  const curPrice = closes[closes.length - 1];
  const minTags = cfg.minTags || 5;
  const tolerance = cfg.tolerance || 0.1;

  const zones = detectZones(klines, tolerance, minTags);
  const { entry: ez, target: tz } = autoPickZones(zones, curPrice);
  const entry = ez ? +ez.price.toFixed(8) : null;
  const target = tz ? +tz.price.toFixed(8) : null;
  const sl = entry ? +(entry * 0.97).toFixed(8) : null;

  const crit = cfg.criteria || {};
  const isOn = (id) => crit[id] ? crit[id].enabled !== false : true;
  let score = 0, total = 0;
  const res = {};

  // 1. Entry zone tags
  if (isOn('tagEntry')) {
    total++;
    const c = crit.tagEntry || { count: 5, tol: 0.1 };
    const tol = entry ? entry * (c.tol / 100) : 0;
    const tags = entry ? klines.filter(k => k.h >= entry - tol && k.l <= entry + tol).length : 0;
    const pass = !!(entry && tags >= c.count);
    if (pass) score++;
    res.tagEntry = { pass, val: entry ? `${tags} tags` : 'no entry', detail: `need ${c.count}` };
  }

  // 2. Target zone tags
  if (isOn('tagTarget')) {
    total++;
    const c = crit.tagTarget || { count: 5, tol: 0.1 };
    const tol = target ? target * (c.tol / 100) : 0;
    const tags = target ? klines.filter(k => k.h >= target - tol && k.l <= target + tol).length : 0;
    const pass = !!(target && tags >= c.count);
    if (pass) score++;
    res.tagTarget = { pass, val: target ? `${tags} tags` : 'no target', detail: `need ${c.count}` };
  }

  // 3. RSI
  if (isOn('rsi')) {
    total++;
    const c = crit.rsi || { period: 14, op: '<', threshold: 40 };
    const rsi = calcRSI(closes, c.period);
    const pass = rsi !== null && (c.op === '<' ? rsi < c.threshold : rsi > c.threshold);
    if (pass) score++;
    res.rsi = { pass, val: rsi !== null ? rsi.toFixed(1) : 'need data', detail: `RSI(${c.period}) ${c.op} ${c.threshold}` };
  }

  // 4. Volume spike
  if (isOn('volume')) {
    total++;
    const c = crit.volume || { mult: 1.5 };
    let pass = false, val = 'need data';
    if (klines.length >= 5) {
      const vols = klines.map(k => k.v);
      const avg = vols.slice(0, -1).reduce((a, b) => a + b, 0) / (vols.length - 1);
      const ratio = vols[vols.length - 1] / avg;
      pass = ratio >= c.mult;
      val = `${ratio.toFixed(2)}x avg`;
    }
    if (pass) score++;
    res.volume = { pass, val, detail: `need ≥${c.mult}x` };
  }

  // 5. EMA trend
  if (isOn('ema')) {
    total++;
    const c = crit.ema || { period: 20, op: 'above' };
    const ema = calcEMA(closes, c.period);
    const pass = !!(ema && (c.op === 'above' ? curPrice > ema : curPrice < ema));
    if (pass) score++;
    res.ema = { pass, val: ema ? `EMA $${ema.toFixed(0)}` : 'need data', detail: `price ${c.op} EMA(${c.period})` };
  }

  // 6. Time filter
  if (isOn('time')) {
    total++;
    const c = crit.time || { from: '08:00', to: '22:00' };
    const now = new Date();
    const cur = now.getUTCHours() * 60 + now.getUTCMinutes();
    const [fh, fm] = c.from.split(':').map(Number);
    const [th, tm] = c.to.split(':').map(Number);
    const pass = cur >= fh * 60 + fm && cur <= th * 60 + tm;
    if (pass) score++;
    res.time = { pass, val: `${String(now.getUTCHours()).padStart(2,'0')}:${String(now.getUTCMinutes()).padStart(2,'0')} UTC`, detail: `${c.from}–${c.to}` };
  }

  // 7. Candle confirm
  if (isOn('candle')) {
    total++;
    const c = crit.candle || { dir: 'bullish' };
    const last = klines[klines.length - 1];
    const bull = last ? last.c > last.o : false;
    const pass = last ? (c.dir === 'bullish' ? bull : !bull) : false;
    if (pass) score++;
    res.candle = { pass, val: last ? `${((last.c - last.o) / last.o * 100).toFixed(2)}%` : 'no data', detail: `want ${c.dir}` };
  }

  // 8. Min spread
  if (isOn('spread')) {
    total++;
    const c = crit.spread || { min: 10 };
    const gap = entry && target ? Math.abs(target - entry) : 0;
    const pass = !!(entry && target && gap >= c.min);
    if (pass) score++;
    res.spread = { pass, val: entry && target ? `$${gap.toFixed(1)}` : 'set entry+target', detail: `need ≥$${c.min}` };
  }

  // 9. Stop loss set
  if (isOn('stoploss')) {
    total++;
    const pass = !!(sl && sl > 0);
    if (pass) score++;
    res.stoploss = { pass, val: pass ? `$${sl.toFixed(2)}` : 'not set (auto-3%)' };
  }

  // 10. Market trend (BTC EMA20)
  if (isOn('mkttrend')) {
    total++;
    const c = crit.mkttrend || { op: 'above' };
    const ema = calcEMA(btcCloses, 20);
    const btcPrice = btcCloses[btcCloses.length - 1];
    const pass = !!(ema && btcPrice && (c.op === 'above' ? btcPrice > ema : btcPrice < ema));
    if (pass) score++;
    res.mkttrend = { pass, val: ema && btcPrice ? (btcPrice > ema ? '↑ above EMA' : '↓ below EMA') : 'no data', detail: 'BTC 1h EMA(20)' };
  }

  return { score, total, criteriaResults: res, entry, target, sl, curPrice, zones };
}

// ── Binance ───────────────────────────────────────────────────────────────────

async function fetchKlines(symbol, interval, limit = 100) {
  const url = `${BASE}/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${symbol}: HTTP ${res.status}`);
  const data = await res.json();
  return data.map(k => ({ t: +k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] }));
}

async function placeMarketOrder(symbol, side, quoteQty, apiKey, apiSecret) {
  const params = { symbol, side, type: 'MARKET', quoteOrderQty: quoteQty.toFixed(2), timestamp: String(Date.now()) };
  const query = new URLSearchParams(params).toString();
  const sig = crypto.createHmac('sha256', apiSecret).update(query).digest('hex');
  const res = await fetch(`${BASE}/api/v3/order?${query}&signature=${sig}`, {
    method: 'POST',
    headers: { 'X-MBX-APIKEY': apiKey }
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.msg || `Order error ${res.status}`);
  return json;
}

// ── Main ──────────────────────────────────────────────────────────────────────

exports.handler = schedule('*/5 * * * *', async () => {
  const store = getStore('sig-bot');
  const newLog = [];
  const log = (msg, isReady = false, isErr = false) => {
    newLog.push({ t: Date.now(), msg, isReady, isErr });
    console.log(msg);
  };

  try {
    let cfg = {};
    try { cfg = (await store.get('config', { type: 'json' })) || {}; } catch (_) {}

    if (!cfg.running) return { statusCode: 200 };

    const minScore = cfg.minScore || 7;
    const tradeAmount = cfg.tradeAmount || 50;
    const interval = cfg.interval || '5m';
    const apiKey = process.env.BINANCE_API_KEY;
    const apiSecret = process.env.BINANCE_API_SECRET;
    const tradingEnabled = !!(cfg.tradingEnabled && apiKey && apiSecret);

    log(`Scan started — ${TOKENS.length} tokens on ${interval}`);

    // Fetch BTC klines for market trend criterion
    const btcRaw = await fetchKlines('BTCUSDT', '1h', 50);
    const btcCloses = btcRaw.map(k => k.c);

    // Load existing results (for trades history)
    let existing = {};
    try { existing = (await store.get('results', { type: 'json' })) || {}; } catch (_) {}
    const trades = existing.trades || [];

    const symbols = {};

    // Scan all 50 tokens in batches of 5
    for (let i = 0; i < TOKENS.length; i += BATCH) {
      const batch = TOKENS.slice(i, i + BATCH);

      const results = await Promise.all(batch.map(async (sym) => {
        try {
          const klines = await fetchKlines(sym, interval, 100);
          const ev = evalCriteria(klines, sym === 'BTCUSDT' ? btcCloses : btcCloses, cfg);
          return {
            sym,
            loaded: true,
            klines,
            btcKlines: btcCloses,
            zones: ev.zones,
            curPrice: ev.curPrice,
            entry: ev.entry ? +ev.entry.toFixed(2) : null,
            target: ev.target ? +ev.target.toFixed(2) : null,
            sl: ev.sl ? +ev.sl.toFixed(2) : null,
            score: ev.score,
            total: ev.total,
            criteriaResults: ev.criteriaResults,
            interval,
            ts: Date.now()
          };
        } catch (e) {
          return { sym, loaded: false, error: e.message, score: 0, total: 10, ts: Date.now() };
        }
      }));

      for (const r of results) {
        symbols[r.sym] = r;

        if (r.loaded && r.score >= minScore) {
          log(`⚡ SIGNAL READY — ${r.sym} ${r.score}/${r.total}`, true);

          if (tradingEnabled) {
            const hasOpen = trades.some(t => t.sym === r.sym && t.status === 'open');
            if (!hasOpen) {
              try {
                const order = await placeMarketOrder(r.sym, 'BUY', tradeAmount, apiKey, apiSecret);
                trades.push({
                  id: Date.now(),
                  sym: r.sym,
                  side: 'BUY',
                  entry: r.entry,
                  target: r.target,
                  sl: r.sl,
                  price: r.curPrice,
                  amount: tradeAmount,
                  orderId: order.orderId,
                  status: 'open',
                  score: r.score,
                  openedAt: Date.now()
                });
                log(`✅ Trade placed: BUY ${r.sym} $${tradeAmount} @ ~$${r.curPrice}`);
              } catch (e) {
                log(`❌ Trade failed ${r.sym}: ${e.message}`, false, true);
              }
            } else {
              log(`⚠ ${r.sym} signal ready — trade already open`);
            }
          }
        }
      }

      if (i + BATCH < TOKENS.length) await new Promise(r => setTimeout(r, 250));
    }

    const scanned = Object.values(symbols).filter(s => s.loaded).length;
    const ready = Object.values(symbols).filter(s => s.loaded && s.score >= minScore).length;
    log(`Scan done — ${scanned} tokens, ${ready} signals ready`);

    // Merge log (keep last 100)
    const prevLog = existing.log || [];
    const mergedLog = [...newLog, ...prevLog].slice(0, 100);

    await store.setJSON('results', { symbols, trades, log: mergedLog, lastScan: Date.now(), botEnabled: true });

    return { statusCode: 200 };
  } catch (e) {
    console.error('Bot scan error:', e);
    return { statusCode: 500 };
  }
});
