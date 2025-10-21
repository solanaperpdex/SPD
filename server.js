// server.js — live BTC/ETH prices + synthetic orderbook + trades + SSE
// Node 20+ (global fetch). Works locally and on Render (PORT env).
import express from "express";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 3000;

/* -------------------- Market data (Binance) -------------------- */
const symbols = ["BTCUSDT", "ETHUSDT"];
const ticker = new Map();     // symbol -> { price, ts }
const candles = new Map();    // symbol -> [{t,o,h,l,c,v}, ...]
const PRICE_TTL_MS = 1000;
const CANDLE_LIMIT = 500;

async function fetchJson(url) {
  const r = await fetch(url, { headers: { "User-Agent": "percolator-sim/1.0" } });
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
  return r.json();
}
async function pullTicker() {
  try {
    const all = await fetchJson("https://api.binance.com/api/v3/ticker/price");
    const now = Date.now();
    for (const s of symbols) {
      const row = all.find((x) => x.symbol === s);
      if (row) ticker.set(s, { price: Number(row.price), ts: now });
    }
  } catch {}
}
async function pullKlines(sym) {
  try {
    const data = await fetchJson(
      `https://api.binance.com/api/v3/klines?symbol=${sym}&interval=1m&limit=${CANDLE_LIMIT}`
    );
    const parsed = data.map((d) => ({ t: d[0], o: +d[1], h: +d[2], l: +d[3], c: +d[4], v: +d[5] }));
    candles.set(sym, parsed);
  } catch {}
}
// prime + poll
await Promise.all(symbols.map((s) => pullKlines(s)));
await pullTicker();
setInterval(pullTicker, PRICE_TTL_MS);
setInterval(() => symbols.forEach((s) => pullKlines(s)), 15000);

/* -------------------- Paper engine -------------------- */
const state = {
  cash: 10000, // USDT
  positions: { BTCUSDT: { qty: 0, entry: 0 }, ETHUSDT: { qty: 0, entry: 0 } },
  leverage: 10,
  im: 0.1,
  mm: 0.05,
};
const trades = []; // newest first: {symbol, side, px, qty, ts}

const mark = (s) => ticker.get(s)?.price ?? NaN;
const pnlFor = (s) => {
  const p = state.positions[s];
  if (!p.qty || !p.entry) return 0;
  return (mark(s) - p.entry) * p.qty;
};
const notional = (s) => Math.abs(state.positions[s].qty) * mark(s);
const usedMargin = () => symbols.reduce((a, s) => a + notional(s) / state.leverage, 0);
const equity = () => state.cash + symbols.reduce((a, s) => a + pnlFor(s), 0);
const marginRatio = () => {
  const um = usedMargin();
  return um === 0 ? Infinity : equity() / um;
};
function liquidationPrice(sym) {
  const pos = state.positions[sym];
  if (pos.qty === 0) return null;
  const side = pos.qty > 0 ? 1 : -1;
  const otherUpnl = symbols.filter((s) => s !== sym).reduce((a, s) => a + pnlFor(s), 0);
  const entry = pos.entry,
    q = Math.abs(pos.qty);
  const N_total = symbols.reduce((a, s) => a + notional(s), 0);
  const targetEquity = state.mm * N_total;
  const needUpnlSelf = targetEquity - (state.cash + otherUpnl);
  const delta = needUpnlSelf / (side * q);
  return entry + delta;
}
function snapshot() {
  return {
    time: Date.now(),
    prices: Object.fromEntries(symbols.map((s) => [s, mark(s)])),
    cash: state.cash,
    equity: equity(),
    usedMargin: usedMargin(),
    marginRatio: marginRatio(),
    positions: Object.fromEntries(
      symbols.map((s) => [
        s,
        {
          qty: state.positions[s].qty,
          entry: state.positions[s].entry,
          upnl: pnlFor(s),
          notional: notional(s),
          liq: liquidationPrice(s),
        },
      ])
    ),
  };
}
function recordTrade(symbol, side, px, qty) {
  trades.unshift({ symbol, side, px, qty, ts: Date.now() });
  if (trades.length > 400) trades.pop();
  // push to SSE clients right away
  for (const c of clients) c.write(`data: ${JSON.stringify({ type: "trade", data: trades[0] })}\n\n`);
}
function trade({ symbol, side, qty }) {
  const px = mark(symbol);
  if (!isFinite(px)) throw new Error("No price");
  const dir = side === "buy" ? 1 : -1;
  const costNotional = Math.abs(qty) * px;
  const neededIM = costNotional / state.leverage;
  if (state.cash < neededIM) throw new Error("Insufficient margin");

  const pos = state.positions[symbol];
  const newQty = pos.qty + dir * qty;

  if (pos.qty === 0) {
    pos.entry = px;
    pos.qty = newQty;
  } else if (Math.sign(pos.qty) === Math.sign(newQty)) {
    const totalNotional = Math.abs(pos.qty) * pos.entry + Math.abs(qty) * px;
    pos.qty = newQty;
    pos.entry = totalNotional / Math.abs(pos.qty);
  } else {
    const closingQty = Math.min(Math.abs(qty), Math.abs(pos.qty));
    const realized = (px - pos.entry) * Math.sign(pos.qty) * closingQty;
    state.cash += realized;
    pos.qty = pos.qty + dir * qty;
    if (pos.qty === 0) pos.entry = 0;
    if (Math.sign(pos.qty) === Math.sign(dir) && Math.abs(qty) > closingQty) pos.entry = px;
  }
  recordTrade(symbol, side, px, qty);
  return { px };
}

/* -------------------- Synthetic order book -------------------- */
function synthOrderBook(sym) {
  const mid = mark(sym);
  if (!isFinite(mid)) return { bids: [], asks: [], mid: null };
  const levels = 25;
  const tick = sym === "BTCUSDT" ? 0.5 : 0.05; // price step
  const baseQty = sym === "BTCUSDT" ? 0.01 : 0.2; // rough size
  const rnd = (a, b) => a + Math.random() * (b - a);

  const asks = [];
  const bids = [];
  for (let i = levels; i >= 1; i--) {
    const p = +(mid + i * tick).toFixed(2);
    const q = +(baseQty * rnd(0.7, 1.6)).toFixed(4);
    asks.push({ p, q });
  }
  for (let i = 1; i <= levels; i++) {
    const p = +(mid - i * tick).toFixed(2);
    const q = +(baseQty * rnd(0.7, 1.6)).toFixed(4);
    bids.push({ p, q });
  }
  return { bids: bids.reverse(), asks, mid };
}

/* --- Stream tiny synthetic prints so the tape looks alive --- */
function noiseTick() {
  for (const sym of symbols) {
    const m = mark(sym);
    if (!isFinite(m)) continue;
    const tick = sym === "BTCUSDT" ? 0.5 : 0.05;
    const px = +(m + (Math.random() - 0.5) * tick * 6).toFixed(2);
    const side = Math.random() > 0.5 ? "buy" : "sell";
    const qty =
      sym === "BTCUSDT"
        ? +(Math.random() * 0.006 + 0.0004).toFixed(6)
        : +(Math.random() * 0.25 + 0.01).toFixed(4);
    recordTrade(sym, side, px, Number(qty));
  }
}
setInterval(noiseTick, 1200);

/* -------------------- SSE -------------------- */
const clients = new Set();
app.get("/events", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  const tick = () => res.write(`data: ${JSON.stringify({ type: "snapshot", data: snapshot() })}\n\n`);
  tick();
  const id = setInterval(tick, 1000);
  clients.add(res);
  req.on("close", () => {
    clearInterval(id);
    clients.delete(res);
  });
});

/* -------------------- API -------------------- */
app.get("/api/tickers", (_req, res) =>
  res.json(Object.fromEntries(symbols.map((s) => [s, ticker.get(s) || null])))
);
app.get("/api/candles", (req, res) => {
  const sym = (req.query.symbol || "BTCUSDT").toString().toUpperCase();
  res.json(candles.get(sym) || []);
});
app.get("/api/orderbook", (req, res) => {
  const sym = (req.query.symbol || "BTCUSDT").toString().toUpperCase();
  res.json(synthOrderBook(sym));
});
app.get("/api/trades", (req, res) => {
  const sym = (req.query.symbol || "").toString().toUpperCase();
  const data = sym ? trades.filter((t) => t.symbol === sym) : trades;
  res.json(data.slice(0, 120));
});
app.get("/api/portfolio", (_req, res) => res.json(snapshot()));

app.post("/api/order", (req, res) => {
  try {
    const { symbol, side, qty } = req.body || {};
    if (!symbols.includes(symbol)) throw new Error("Unsupported symbol");
    if (!["buy", "sell"].includes(side)) throw new Error("side must be buy/sell");
    if (!(qty > 0)) throw new Error("qty > 0");
    const fill = trade({ symbol, side, qty });
    const snap = snapshot();
    for (const c of clients) c.write(`data: ${JSON.stringify({ type: "snapshot", data: snap })}\n\n`);
    res.json({ ok: true, fill, snapshot: snap });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message || String(e) });
  }
});

app.get("/health", (_req, res) => res.json({ ok: true }));
app.get("/", (_req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

app.listen(PORT, () => console.log(`Sim dashboard running on http://localhost:${PORT}`));
