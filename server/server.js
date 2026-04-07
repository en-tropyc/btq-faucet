require('dotenv').config();

const express = require('express');
const crypto = require('crypto');
const path = require('path');
const http = require('http');
const { WebSocketServer } = require('ws');
const FaucetDB = require('./db');

// Configuration from environment
const CONFIG = {
  RPC_HOST: process.env.RPC_HOST || '127.0.0.1',
  RPC_PORT: parseInt(process.env.RPC_PORT || '18334'),
  RPC_USER: process.env.RPC_USER || 'btqrpc',
  RPC_PASS: process.env.RPC_PASS || '',
  RPC_WALLET: process.env.RPC_WALLET || 'faucet',
  FAUCET_ADDRESS: process.env.FAUCET_ADDRESS || '', // Main faucet address for change
  FAUCET_FEE: parseFloat(process.env.FAUCET_FEE || '0.0001'),
  REWARD_PER_MINUTE: parseFloat(process.env.REWARD_PER_MINUTE || '0.01'),
  MIN_CLAIM: parseFloat(process.env.MIN_CLAIM || '0.01'),
  DIFFICULTY_BASE: parseInt(process.env.DIFFICULTY_BASE || '4'),
  DIFFICULTY_STEP_SECONDS: parseInt(process.env.DIFFICULTY_STEP_SECONDS || '300'),
  ACTIVE_SHARE_WINDOW: parseInt(process.env.ACTIVE_SHARE_WINDOW || '30'),
  MAX_SESSION_SECONDS: parseInt(process.env.MAX_SESSION_SECONDS || '150'), // 2.5 minutes
  SESSION_EXPIRE_SECONDS: parseInt(process.env.SESSION_EXPIRE_SECONDS || '3600'),
  IP_SALT: process.env.IP_SALT || crypto.randomBytes(32).toString('hex'),
  PORT: parseInt(process.env.PORT || '3000'),
  // hCaptcha configuration (optional)
  HCAPTCHA_SITEKEY: process.env.HCAPTCHA_SITEKEY || '',
  HCAPTCHA_SECRET: process.env.HCAPTCHA_SECRET || ''
};

const app = express();
const db = new FaucetDB();

app.use(express.json());
app.use(express.static(path.join(__dirname, '../web')));

// RPC client with Basic auth
async function btqRPC(method, params = []) {
  const url = `http://${CONFIG.RPC_HOST}:${CONFIG.RPC_PORT}/wallet/${CONFIG.RPC_WALLET}`;
  const auth = Buffer.from(`${CONFIG.RPC_USER}:${CONFIG.RPC_PASS}`).toString('base64');

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Basic ${auth}`
      },
      body: JSON.stringify({
        jsonrpc: '1.0',
        id: Date.now(),
        method,
        params
      })
    });

    const data = await response.json();

    if (data.error) {
      // Try to auto-load wallet if it's not loaded
      if (data.error.message && data.error.message.includes('not found') && method !== 'loadwallet') {
        console.log('Wallet not loaded, attempting to load...');
        await btqRPC('loadwallet', [CONFIG.RPC_WALLET]);
        // Retry original request
        return await btqRPC(method, params);
      }
      throw new Error(data.error.message || 'RPC error');
    }

    return data.result;
  } catch (error) {
    console.error(`RPC Error (${method}):`, error.message);
    throw error;
  }
}

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

// Hash IP for privacy
function hashIP(ip, salt = CONFIG.IP_SALT) {
  return crypto.createHash('sha256').update(ip + salt).digest('hex');
}

// Get client IP
function getClientIP(req) {
  return req.headers['x-forwarded-for']?.split(',')[0] ||
         req.connection.remoteAddress ||
         req.socket.remoteAddress;
}

function computeDifficulty(baseDifficulty, activeSeconds) {
  const steps = Math.floor(activeSeconds / CONFIG.DIFFICULTY_STEP_SECONDS);
  return baseDifficulty + steps;
}

function computeAccrued(activeSeconds) {
  return (activeSeconds / 60) * CONFIG.REWARD_PER_MINUTE;
}

// BTQ address formats (from btq-core chainparams.cpp):
// - Dilithium base58: 'n' (testnet/signet/regtest), 'd' (mainnet) — ~50 chars
// - Dilithium bech32: HRP 'tdbt' (testnet), 'sdbt' (signet), 'rdbt' (regtest), 'dbtc' (mainnet)
// - SegWit bech32: HRP 'tbtq' (testnet), 'qtb' (signet), 'qcrt' (regtest), 'qbtc' (mainnet)
// - Legacy base58: 'm'/'n' (testnet/signet/regtest), 'B' (mainnet) — 25-34 chars

function getAddressType(address) {
  if (!address || typeof address !== 'string') return null;

  // Dilithium base58 addresses (longer ~50 chars)
  if (/^[nd][a-km-zA-HJ-NP-Z1-9]{40,60}$/.test(address)) {
    return 'dilithium';
  }

  // Dilithium bech32 addresses (HRP: tdbt, sdbt, rdbt, dbtc)
  if (/^(tdbt|sdbt|rdbt|dbtc)1[a-z0-9]{38,}$/.test(address)) {
    return 'dilithium';
  }

  // SegWit bech32 addresses (HRP: tbtq, qtb, qcrt, qbtc)
  if (/^(tbtq|qtb|qcrt|qbtc)1q[a-z0-9]{38,}$/.test(address)) {
    return 'segwit';
  }

  // Legacy base58 addresses (shorter)
  if (/^[mMnNB][a-km-zA-HJ-NP-Z1-9]{25,34}$/.test(address)) {
    return 'legacy';
  }

  return null;
}

function validateAddress(address) {
  return getAddressType(address) !== null;
}

// Verify hCaptcha token
async function verifyCaptcha(token, remoteIp) {
  if (!CONFIG.HCAPTCHA_SECRET) {
    // Captcha not configured, skip verification
    return true;
  }

  try {
    const response = await fetch('https://api.hcaptcha.com/siteverify', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: new URLSearchParams({
        secret: CONFIG.HCAPTCHA_SECRET,
        response: token,
        remoteip: remoteIp
      })
    });

    const data = await response.json();
    return data.success === true;
  } catch (error) {
    console.error('Captcha verification error:', error);
    return false;
  }
}

// Select coins for transaction
function selectCoins(utxos, targetAmount) {
  // Sort UTXOs by amount (ascending) for efficient selection
  const sorted = [...utxos].sort((a, b) => a.amount - b.amount);

  let selected = [];
  let total = 0;

  for (const utxo of sorted) {
    selected.push(utxo);
    total += utxo.amount;

    if (total >= targetAmount) {
      return { selected, total };
    }
  }

  throw new Error('Insufficient funds');
}

// Send transaction with automatic signing method detection
async function sendTx(address, amount, fee) {
  try {
    // 1. List unspent outputs (including unconfirmed)
    const utxos = await btqRPC('listunspent', [0]);

    if (!utxos || utxos.length === 0) {
      throw new Error('No UTXOs available');
    }

    // 2. Select coins
    const targetAmount = amount + fee;
    const { selected, total } = selectCoins(utxos, targetAmount);

    // 3. Determine signing method based on UTXO address types
    const hasDilithiumInputs = selected.some(utxo => getAddressType(utxo.address) === 'dilithium');
    const hasStandardInputs = selected.some(utxo => getAddressType(utxo.address) !== 'dilithium');

    if (hasDilithiumInputs && hasStandardInputs) {
      throw new Error('Cannot mix Dilithium and standard inputs in one transaction');
    }

    // 4. Prepare inputs
    const inputs = selected.map(utxo => ({
      txid: utxo.txid,
      vout: utxo.vout
    }));

    // 5. Prepare outputs
    const outputs = { [address]: amount };

    // Add change output if needed (send to faucet address or source)
    const change = total - targetAmount;
    if (change > 0.00001) { // Dust threshold
      // Use configured faucet address, or fallback to source address
      const changeAddress = CONFIG.FAUCET_ADDRESS || selected[0].address;
      outputs[changeAddress] = parseFloat(change.toFixed(8));
    }

    // 6. Create raw transaction
    const rawTx = await btqRPC('createrawtransaction', [inputs, outputs]);

    // 7. Sign with appropriate method
    const signMethod = hasDilithiumInputs ? 'signtransactionwithdilithium' : 'signrawtransactionwithwallet';
    const signedTx = await btqRPC(signMethod, [rawTx]);

    if (!signedTx.complete) {
      throw new Error('Transaction signing incomplete');
    }

    // 7. Send transaction
    const txid = await btqRPC('sendrawtransaction', [signedTx.hex]);

    return txid;
  } catch (error) {
    if (error.message.includes('locked')) {
      throw new Error('Wallet is locked. Please unlock with: btq-cli -rpcwallet=faucet walletpassphrase <passphrase> 60');
    }
    throw error;
  }
}

// API Endpoints

// GET /api/config - Returns public configuration (captcha sitekey)
app.get('/api/config', (req, res) => {
  res.json({
    captchaSiteKey: CONFIG.HCAPTCHA_SITEKEY || null,
    minClaim: CONFIG.MIN_CLAIM,
    rewardPerMinute: CONFIG.REWARD_PER_MINUTE
  });
});

// POST /api/mining/start
app.post('/api/mining/start', async (req, res) => {
  try {
    const { address, captchaToken } = req.body;

    if (!validateAddress(address)) {
      return res.status(400).json({ error: 'Invalid address' });
    }

    // Verify captcha if configured
    if (CONFIG.HCAPTCHA_SECRET) {
      if (!captchaToken) {
        return res.status(400).json({ error: 'Captcha verification required' });
      }

      const ip = getClientIP(req);
      const captchaValid = await verifyCaptcha(captchaToken, ip);
      if (!captchaValid) {
        return res.status(400).json({ error: 'Captcha verification failed' });
      }
    }

    const ip = getClientIP(req);
    const sessionId = crypto.randomBytes(16).toString('hex');
    const nonce = crypto.randomBytes(16).toString('hex');
    const startedAt = nowSec();

    const session = {
      sessionId,
      address,
      nonce,
      baseDifficulty: CONFIG.DIFFICULTY_BASE,
      currentDifficulty: CONFIG.DIFFICULTY_BASE,
      startedAt,
      ipHash: hashIP(ip)
    };

    db.insertSession(session);

    res.json({
      sessionId,
      nonce,
      difficulty: CONFIG.DIFFICULTY_BASE,
      startedAt,
      minClaim: CONFIG.MIN_CLAIM
    });
  } catch (error) {
    console.error('Start mining error:', error);
    res.status(500).json({ error: error.message });
  }
});

// POST /api/mining/stop
app.post('/api/mining/stop', (req, res) => {
  try {
    const { sessionId } = req.body;

    if (!sessionId) {
      return res.status(400).json({ error: 'Missing sessionId' });
    }

    const session = db.getSession(sessionId);
    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    if (session.status !== 'active') {
      return res.status(400).json({ error: `Session is ${session.status}` });
    }

    const now = nowSec();
    let activeSeconds = session.active_seconds || 0;

    const lastActivity = session.last_share_at || session.started_at;
    if (lastActivity) {
      const delta = Math.min(now - lastActivity, CONFIG.ACTIVE_SHARE_WINDOW);
      if (delta > 0) {
        activeSeconds += delta;
      }
    }

    const accrued = computeAccrued(activeSeconds);
    const difficulty = computeDifficulty(session.base_difficulty, activeSeconds);

    db.stopSession(sessionId, {
      stoppedAt: now,
      activeSeconds,
      accrued,
      currentDifficulty: difficulty
    });

    res.json({
      sessionId,
      activeSeconds,
      accrued,
      difficulty,
      minClaim: CONFIG.MIN_CLAIM
    });
  } catch (error) {
    console.error('Stop mining error:', error);
    res.status(500).json({ error: error.message });
  }
});

// POST /api/mining/resume
app.post('/api/mining/resume', (req, res) => {
  try {
    const { sessionId } = req.body;

    if (!sessionId) {
      return res.status(400).json({ error: 'Missing sessionId' });
    }

    const session = db.getSession(sessionId);
    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    if (session.status !== 'stopped') {
      return res.status(400).json({ error: `Cannot resume: session is ${session.status}` });
    }

    db.resumeSession(sessionId);

    res.json({
      sessionId,
      status: 'active',
      accrued: session.accrued || 0,
      activeSeconds: session.active_seconds || 0,
      difficulty: session.current_difficulty || session.base_difficulty
    });
  } catch (error) {
    console.error('Resume mining error:', error);
    res.status(500).json({ error: error.message });
  }
});

// POST /api/mining/claim
app.post('/api/mining/claim', async (req, res) => {
  try {
    const { sessionId } = req.body;

    if (!sessionId) {
      return res.status(400).json({ error: 'Missing sessionId' });
    }

    const session = db.getSession(sessionId);
    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    if (session.status === 'claimed') {
      return res.status(400).json({ error: 'Session already claimed' });
    }

    if (session.status !== 'stopped') {
      return res.status(400).json({ error: 'Session must be stopped before claiming' });
    }

    const accrued = session.accrued || 0;
    if (accrued < CONFIG.MIN_CLAIM) {
      return res.status(400).json({
        error: 'Minimum claim not reached',
        minClaim: CONFIG.MIN_CLAIM,
        accrued
      });
    }

    const amount = parseFloat(accrued.toFixed(8));

    let txid;
    try {
      txid = await sendTx(session.address, amount, CONFIG.FAUCET_FEE);
    } catch (error) {
      db.insertPayout({
        sessionId,
        address: session.address,
        amount,
        txid: null,
        status: 'failed'
      });

      if (error.message.includes('locked')) {
        return res.status(503).json({ error: error.message });
      }
      if (error.message.includes('Insufficient')) {
        const balance = await btqRPC('getbalance');
        return res.status(503).json({
          error: 'Faucet has insufficient funds',
          balance: balance
        });
      }
      throw error;
    }

    db.insertPayout({
      sessionId,
      address: session.address,
      amount,
      txid,
      status: 'success'
    });

    db.markSessionClaimed(sessionId, {
      claimedAt: nowSec(),
      txid
    });

    res.json({
      success: true,
      txid,
      amount
    });
  } catch (error) {
    console.error('Claim error:', error);
    res.status(500).json({ error: error.message });
  }
});

// GET /api/health
app.get('/api/health', async (req, res) => {
  try {
    // Test RPC connection
    const balance = await btqRPC('getbalance');
    const walletInfo = await btqRPC('getwalletinfo');

    res.json({
      status: 'ok',
      balance: balance,
      rpc: 'ok',
      walletLoaded: true,
      walletUnlocked: !walletInfo.unlocked_until || walletInfo.unlocked_until > 0
    });
  } catch (error) {
    res.status(503).json({
      status: 'error',
      rpc: 'fail',
      error: error.message
    });
  }
});

// Deprecated endpoints (single-shot PoW flow)
app.get('/api/challenge', (req, res) => {
  res.status(410).json({ error: 'Deprecated. Use /api/mining/start and WebSocket shares.' });
});

app.post('/api/claim', (req, res) => {
  res.status(410).json({ error: 'Deprecated. Use /api/mining/stop and /api/mining/claim.' });
});

// Periodic cleanup (every hour)
setInterval(() => {
  try {
    const now = nowSec();
    const cutoff = now - CONFIG.SESSION_EXPIRE_SECONDS;
    const expired = db.expireStaleSessions(cutoff);
    if (expired.changes > 0) {
      console.log(`Expired ${expired.changes} stale sessions`);
    }
  } catch (error) {
    console.error('Cleanup error:', error);
  }
}, 3600000);

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws) => {
  ws.on('message', (data) => {
    let message;
    try {
      message = JSON.parse(data.toString());
    } catch (error) {
      ws.send(JSON.stringify({ type: 'error', error: 'Invalid JSON' }));
      return;
    }

    if (message.type !== 'share') {
      ws.send(JSON.stringify({ type: 'error', error: 'Unsupported message type' }));
      return;
    }

    const { sessionId, counter } = message;
    if (!sessionId || counter === undefined) {
      ws.send(JSON.stringify({ type: 'error', error: 'Missing sessionId or counter' }));
      return;
    }

    const session = db.getSession(sessionId);
    if (!session) {
      ws.send(JSON.stringify({ type: 'error', error: 'Session not found' }));
      return;
    }

    if (session.status !== 'active') {
      ws.send(JSON.stringify({ type: 'error', error: `Session is ${session.status}` }));
      return;
    }

    const now = nowSec();
    const lastActivity = session.last_share_at || session.started_at;
    if (now - lastActivity > CONFIG.SESSION_EXPIRE_SECONDS) {
      db.expireSession(sessionId, { expiredAt: now });
      ws.send(JSON.stringify({ type: 'error', error: 'Session expired' }));
      return;
    }

    // Check wall-clock session duration cap
    const sessionDuration = now - session.started_at;
    if (sessionDuration >= CONFIG.MAX_SESSION_SECONDS) {
      const activeSeconds = session.active_seconds || 0;
      const accrued = computeAccrued(activeSeconds);

      db.stopSession(sessionId, {
        stoppedAt: now,
        activeSeconds,
        currentDifficulty: session.current_difficulty,
        accrued
      });

      ws.send(JSON.stringify({
        type: 'session_complete',
        activeSeconds,
        accrued,
        message: 'Maximum session time reached'
      }));
      return;
    }

    if (counter <= session.last_counter) {
      ws.send(JSON.stringify({ type: 'error', error: 'Stale share' }));
      return;
    }

    const difficultyBefore = session.current_difficulty;
    const input = `${session.nonce}:${session.address}:${counter}`;
    const hash = crypto.createHash('sha256').update(input).digest('hex');
    const target = '0'.repeat(difficultyBefore);

    if (!hash.startsWith(target)) {
      ws.send(JSON.stringify({ type: 'error', error: 'Invalid share' }));
      return;
    }

    let activeSeconds = session.active_seconds || 0;
    const lastShareTime = session.last_share_at || session.started_at;
    if (lastShareTime) {
      const delta = Math.min(now - lastShareTime, CONFIG.ACTIVE_SHARE_WINDOW);
      if (delta > 0) {
        activeSeconds += delta;
      }
    }

    const difficultyAfter = computeDifficulty(session.base_difficulty, activeSeconds);
    const accrued = computeAccrued(activeSeconds);

    db.updateSessionShare(sessionId, {
      lastShareAt: now,
      lastCounter: counter,
      activeSeconds,
      currentDifficulty: difficultyAfter,
      accrued
    });

    db.insertShare({
      sessionId,
      counter,
      difficulty: difficultyBefore
    });

    ws.send(JSON.stringify({
      type: 'accepted',
      sessionId,
      activeSeconds,
      accrued,
      difficulty: difficultyAfter
    }));
  });
});

// Start server
server.listen(CONFIG.PORT, () => {
  console.log(`BTQ Faucet running on port ${CONFIG.PORT}`);
  console.log(`RPC: ${CONFIG.RPC_HOST}:${CONFIG.RPC_PORT}`);
  console.log(`Wallet: ${CONFIG.RPC_WALLET}`);
  console.log(`Reward: ${CONFIG.REWARD_PER_MINUTE} BTQ/min`);
  console.log(`Min claim: ${CONFIG.MIN_CLAIM} BTQ`);
  console.log(`Difficulty base: ${CONFIG.DIFFICULTY_BASE}`);
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\nShutting down...');
  db.close();
  process.exit(0);
});
