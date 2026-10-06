'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');

const P2MR = 'tbtq1zqtr809hratgku9hsyxah7eejenjhqv09hx0m72wwr6hxd4nk6mtq0eh00m';
const WALLET_ORIGIN = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';

let child;
let baseUrl;
let tmpDir;

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

async function startSession(address) {
  const res = await fetch(`${baseUrl}/api/mining/start`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ address }),
  });
  return { status: res.status, body: await res.json(), headers: res.headers };
}

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'btq-faucet-test-'));
  const port = await freePort();
  // Nothing listens here, so every node RPC fails the way it does when the faucet's node is down.
  const closedRpcPort = await freePort();
  baseUrl = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      PORT: String(port),
      RPC_HOST: '127.0.0.1',
      RPC_PORT: String(closedRpcPort),
      RPC_PASS: 'test',
      IP_SALT: 'test',
      DB_PATH: path.join(tmpDir, 'faucet.db'),
      HCAPTCHA_SECRET: '',
      HCAPTCHA_SITEKEY: '',
      HEALTH_API_KEY: '',
      BECH32_HRP: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error(`server did not start:\n${output}`)), 10000);
    child.stdout.on('data', (chunk) => {
      output += chunk;
      if (output.includes('BTQ Faucet running on port')) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.stderr.on('data', (chunk) => { output += chunk; });
    child.once('exit', (code) => reject(new Error(`server exited with ${code}:\n${output}`)));
  });
});

after(() => {
  child.kill();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// startLimiter allows 5 starts per minute per IP; this file makes 4.
test('POST /api/mining/start accepts a P2MR address', async () => {
  const { status, body } = await startSession(P2MR);
  assert.equal(status, 200);
  assert.match(body.sessionId, /^[0-9a-f]{32}$/);
});

test('POST /api/mining/start stores bech32 addresses in lowercase', async () => {
  const { status, body } = await startSession(P2MR.toUpperCase());
  assert.equal(status, 200);
  const db = new Database(path.join(tmpDir, 'faucet.db'), { readonly: true });
  const row = db.prepare('SELECT address FROM sessions WHERE session_id = ?').get(body.sessionId);
  db.close();
  assert.equal(row.address, P2MR);
});

test('POST /api/mining/start rejects mainnet-looking and corrupted addresses', async () => {
  for (const address of [
    'btq1qw508d6qejxtdg4y5r3zarvary0c5xw7kp0lvcc',
    'tbtq1zqtr809hratgku9hsyxah7eejenjhqv09hx0m72wwr6hxd4nk6mtq0eh00n',
  ]) {
    const { status, body, headers } = await startSession(address);
    assert.equal(status, 400, address);
    assert.deepEqual(body, { error: 'Invalid address' });
    assert.equal(headers.get('access-control-allow-origin'), null);
  }
});

test('GET /api/config exposes the bech32 HRP', async () => {
  const res = await fetch(`${baseUrl}/api/config`);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).bech32Hrp, 'tbtq');
  assert.equal(res.headers.get('access-control-allow-origin'), null);
});

test('GET /api/capabilities tells any origin that P2MR and ?address= are supported', async () => {
  const res = await fetch(`${baseUrl}/api/capabilities`, { headers: { origin: WALLET_ORIGIN, accept: 'application/json' } });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('access-control-allow-origin'), '*');
  assert.deepEqual(await res.json(), {
    addressTypes: ['p2mr', 'segwit', 'dilithium', 'legacy'],
    prefill: true,
    version: 1,
  });
});

test('GET /api/health is readable cross-origin, including when the node is down', async () => {
  const res = await fetch(`${baseUrl}/api/health`, { headers: { origin: WALLET_ORIGIN, accept: 'application/json' } });
  assert.equal(res.status, 503);
  assert.equal(res.headers.get('access-control-allow-origin'), '*');
  assert.deepEqual(await res.json(), { status: 'error' });
});

// Keep last: it uses up apiLimiter's 30 requests per minute for this IP.
test('GET /api/health stays readable cross-origin when rate limited', async () => {
  let res;
  for (let i = 0; i < 40; i++) {
    res = await fetch(`${baseUrl}/api/health`, { headers: { origin: WALLET_ORIGIN } });
    await res.arrayBuffer();
    if (res.status === 429) break;
  }
  assert.equal(res.status, 429);
  assert.equal(res.headers.get('access-control-allow-origin'), '*');
});
