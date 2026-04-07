# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Bitcoin Quantum (BTQ) testnet faucet. Users mine PoW shares in-browser via Web Worker + WebSocket, accrue BTQ rewards over time, then claim a payout transaction signed with Dilithium (quantum-resistant) keys.

## Commands

```bash
# Install dependencies (run from server/)
cd server && npm install

# Start server (production)
cd server && npm start

# Start server (dev with auto-reload via nodemon)
cd server && npm run dev

# Start with regtest btqd (auto-creates wallet, funds it, configures env)
./start-regtest.sh

# Start with testnet btqd (requires RPC_PASS env var)
RPC_PASS=yourpass ./start-testnet.sh

# Production process management (PM2)
pm2 start ecosystem.config.js
pm2 logs btq-faucet

# Query the SQLite database
sqlite3 server/faucet.db
```

## Architecture

**Server** (`server/server.js`): Express + `ws` WebSocket server. Handles the full mining lifecycle:
- `POST /api/mining/start` - creates session, returns nonce + difficulty
- `WebSocket /ws` - receives share submissions, verifies SHA-256 PoW, tracks active time
- `POST /api/mining/stop` - finalizes session accrual
- `POST /api/mining/resume` - resumes a stopped session for more mining
- `POST /api/mining/claim` - builds and sends a BTQ transaction via `btqd` RPC
- `GET /api/config` - returns public config (captcha sitekey, reward rate)
- `GET /api/health` - checks btqd RPC connection and wallet status

Transaction signing auto-detects Dilithium vs standard inputs and uses `signtransactionwithdilithium` or `signrawtransactionwithwallet` accordingly. Cannot mix input types.

**Database** (`server/db.js`): `better-sqlite3` with tables: `sessions`, `shares`, `payouts`, plus legacy `challenges`/`claims`. All queries are prepared statements.

**Frontend** (`web/`): Single-page app with state machine (READY -> MINING -> CLAIMABLE -> CLAIMED). `app.js` manages UI state transitions and WebSocket lifecycle. `worker.js` is a Web Worker that does SHA-256 hashing in batches of 10,000 and posts shares back to the main thread.

**PoW scheme**: `SHA-256(nonce:address:counter)` must start with N leading zeros (difficulty). Difficulty ramps based on `active_seconds / DIFFICULTY_STEP_SECONDS`. Active time is tracked via share submission gaps capped at `ACTIVE_SHARE_WINDOW` (30s). Sessions auto-stop at `MAX_SESSION_SECONDS` (150s wall-clock).

## Configuration

All config via environment variables (see `.env.example`). The `.env` file goes in `server/` for `dotenv` to find it. Key settings:
- `RPC_*` - btqd JSON-RPC connection
- `FAUCET_ADDRESS` - change address for transactions
- `DIFFICULTY_BASE` / `DIFFICULTY_STEP_SECONDS` - PoW difficulty ramp
- `HCAPTCHA_SITEKEY` / `HCAPTCHA_SECRET` - optional hCaptcha integration
- `MAX_SESSION_SECONDS` - wall-clock session cap (default 150s)

## BTQ Address Formats

Address validation appears in both `server/server.js` and `web/app.js` (kept in sync manually). Formats derived from btq-core's `chainparams.cpp`:
- Dilithium base58: `^[nd][base58]{40,60}$`
- Dilithium bech32: HRPs `tdbt` (testnet), `sdbt` (signet), `rdbt` (regtest), `dbtc` (mainnet)
- SegWit bech32: HRPs `tbtq` (testnet), `qtb` (signet), `qcrt` (regtest), `qbtc` (mainnet)
- Legacy base58: `^[mMnNB][base58]{25,34}$`

## Deployment

Production uses PM2 (`ecosystem.config.js`) behind nginx (`nginx/faucet.conf`). Systemd service file at `btq-faucet.service`. Deploy script at `deploy.sh`.
