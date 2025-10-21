# Percolator • Perp Sim

![Perp Sim Banner](banner.jpeg)

A fast, self‑contained **perp-style dashboard** with **live BTC/ETH prices**, a **synthetic order book**, and a **paper-trading engine**. Built with **Node 20**, **Express**, **SSE**, and **Lightweight Charts**. Perfect for demos, hackathons, and prototyping on top of Solana-style perp ideas while real programs are still in development.

---

## ✨ Features

- **Live market data** from Binance (BTCUSDT / ETHUSDT)
- **1‑minute candles** rendered via Lightweight Charts
- **Synthetic order book** with mid and BBO that updates continuously
- **Paper trading** (market orders) with:
  - Cross‑asset account in USDT
  - Equity, used margin, margin ratio
  - uPnL and **estimated liquidation price**
- **Trades tape** showing your fills + small “noise” prints for a lively UI
- **Realtime updates** over Server‑Sent Events (SSE)
- **Deploy‑ready** for Render free tier

> ⚠️ This is **simulation only**. No real trading is executed on any exchange or chain.

---

## 🗂️ Project Structure

```
.
├─ public/
│  └─ index.html         # UI (chart, orderbook, trades, order form)
├─ server.js             # Express server, market data, order book, SSE
├─ package.json
└─ banner.png
```

---

## 🚀 Quick Start (Local)

1. **Install** (Node 20+ recommended):
   ```bash
   npm install
   ```
2. **Run**:
   ```bash
   node server.js
   ```
3. Open **http://localhost:3000**

If you see a blank chart: make sure the `#tv` container has height (this repo’s HTML already sets it to `420px`).

---

## ☁️ Deploy on Render

1. Push this folder to a **GitHub** repo.
2. On **Render** → **New** → **Web Service**:
   - **Runtime**: Node
   - **Build Command**: `npm install`
   - **Start Command**: `node server.js`
   - **Instance Type**: Free
3. Render will provide a public URL (e.g. `https://perp-sim.onrender.com`).

`server.js` listens on `process.env.PORT` automatically.

---

## 🔌 API (for integrations)

- `GET /events` → **SSE** stream of periodic `snapshot` messages and live `trade` events.
- `GET /api/tickers` → latest marks for BTCUSDT, ETHUSDT.
- `GET /api/candles?symbol=BTCUSDT` → 1‑minute klines (limit 500).
- `GET /api/orderbook?symbol=BTCUSDT` → synthetic top‑25 bids/asks + mid.
- `GET /api/trades?symbol=BTCUSDT` → recent trades (your fills + noise).
- `GET /api/portfolio` → cash, equity, margin, positions.
- `POST /api/order` body:
  ```json
  { "symbol": "BTCUSDT", "side": "buy", "qty": 0.001 }
  ```

> Market orders only (for now). Limit orders & matching can be added if you want to extend the sim into a full book.

---

## ⚙️ Configuration Notes

- **Symbols** are defined in `server.js`:
  ```js
  const symbols = ["BTCUSDT", "ETHUSDT"];
  ```
  Add more Binance symbols if desired.
- **Polling**:
  - Ticker: every **1s**
  - Candles: every **15s**
- **Synthetic order book** is generated around the current mid; tweak `tick` and `baseQty` per symbol in `server.js` for different density.
- **Starting balance**: `state.cash = 10_000` USDT (edit in `server.js`).

---

## 🧠 Why this exists

The goal is to mirror the **look & feel** of a modern perp exchange while your Solana programs (router/slab) are still under active development. It’s a great place to prototype UX, risk & margin logic, and test clients before wiring on‑chain handlers.

---

## 📄 License

MIT — do whatever, attribution appreciated.
