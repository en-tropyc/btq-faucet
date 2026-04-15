# BTQ Faucet Security Audit

**Date:** 2026-04-15
**Scope:** Full codebase review of [en-tropyc/btq-faucet](https://github.com/en-tropyc/btq-faucet)
**Focus:** XSS, injection, DoS, supply chain, configuration

---

## Executive Summary

The faucet is a Node.js/Express app with a WebSocket mining system, SQLite persistence, and a static frontend. The SQL layer is well-written (parameterized queries throughout), and the deployment configs (systemd, nginx) are solid. However, there are **critical XSS vulnerabilities** in the frontend, **no rate limiting** anywhere in the stack, and several missing hardening measures.

| Severity | Count | Summary |
|----------|-------|---------|
| Critical | 2 | XSS via `innerHTML`, no rate limiting |
| High | 3 | WebSocket origin bypass, unvalidated input types, info disclosure |
| Medium | 4 | Missing CSP, external scripts without SRI, raw error leakage, empty RPC password default |
| Low | 2 | Floating point arithmetic, IP salt regeneration on restart |

---

## Critical Issues

### 1. XSS via `innerHTML` with Server-Supplied Data

**Files:** `web/app.js:181`, `web/app.js:190-202`

The `showMessage()` function renders content using `innerHTML`:

```js
// web/app.js:181
function showMessage(text, type = 'error') {
  messageText.innerHTML = text;  // <-- unsanitized HTML injection
}
```

This is called by `showError()` and `showSuccess()` with strings that originate from the server or WebSocket:

| Call Site | Source | Vector |
|-----------|--------|--------|
| `app.js:394` | `data.error` from WebSocket message | Server/RPC error string rendered as HTML |
| `app.js:513` | `data.error` from WebSocket message | Same |
| `app.js:418, 446, 474, 574` | `error.message` from fetch response | Server error passthrough |
| `app.js:190-193` | `txid` interpolated into `<a>` tag | RPC return value rendered as HTML |

The server passes raw `error.message` to the client at multiple endpoints:

```js
// server/server.js:305, 357, 474
res.status(500).json({ error: error.message });
```

These can contain RPC node error strings. If the RPC node returns a crafted error (compromised node, MITM on the RPC connection), the string flows through:

```
RPC error.message → Express JSON response → fetch → showError() → showMessage() → innerHTML
```

This is a **reflected XSS** path. An attacker who controls the RPC response (or any server error string) can execute arbitrary JavaScript in the user's browser.

Additionally, `showError()` builds an inline `onclick` handler via string concatenation:

```js
// web/app.js:199
html += ` <a href="#" onclick="${actionable.action}; return false;">${actionable.text}</a>`;
```

Currently all callers pass hardcoded strings, but this pattern is one refactor away from being exploitable.

**Recommendation:**
- Replace `messageText.innerHTML = text` with `messageText.textContent = text` for all error messages
- For `showSuccess()` where link markup is needed, build DOM elements programmatically:
  ```js
  const link = document.createElement('a');
  link.href = `https://explorer.bitcoinquantum.com/tx/${txid}`;
  link.textContent = 'View on Block Explorer';
  link.target = '_blank';
  messageText.textContent = 'Transaction sent successfully! ';
  messageText.appendChild(link);
  ```
- Sanitize all server error responses — return generic messages to the client, log details server-side

---

### 2. No Rate Limiting

**Files:** `server/server.js` (all endpoints), WebSocket handler

There is zero rate limiting anywhere in the application:

| Endpoint | Attack | Impact |
|----------|--------|--------|
| `POST /api/mining/start` | Flood session creation | SQLite bloat, disk/memory exhaustion |
| `POST /api/mining/claim` | Automated PoW + claim loop | Wallet drain |
| `WebSocket /ws` | Unlimited connections and messages | CPU exhaustion (SHA-256 verification + DB writes per message) |
| `GET /api/health` | Rapid polling | Information disclosure amplification, minor resource use |

The `ip_hash` field is stored in the database but **never used for any rate-limiting or abuse-detection logic**. It is effectively dead code from a security perspective.

hCaptcha is optional — when `HCAPTCHA_SECRET` is not set (the default), captcha verification is skipped entirely:

```js
// server/server.js:139
if (!CONFIG.HCAPTCHA_SECRET) {
  return true;  // Captcha not configured, skip verification
}
```

This means in the default deployment, there is no bot protection at all.

**Recommendation:**
- Add per-IP rate limiting via `express-rate-limit` or nginx `limit_req_zone`:
  - `/api/mining/start`: 5 requests per minute per IP
  - `/api/mining/claim`: 3 requests per minute per IP
  - WebSocket: max 10 connections per IP, max 50 messages per second per connection
- Use the already-stored `ip_hash` to enforce per-IP session limits (e.g., max 3 active sessions)
- Make hCaptcha mandatory in production or add an alternative rate-limiting mechanism

---

## High Severity Issues

### 3. Cross-Site WebSocket Hijacking (CSWSH)

**File:** `server/server.js:524`

The WebSocket server does not validate the `Origin` header:

```js
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws) => {
  // No origin check — any website can connect
```

Any malicious website can open a WebSocket connection to the faucet and submit shares for known session IDs. This enables cross-origin interaction from attacker-controlled pages.

**Recommendation:**
```js
wss.on('connection', (ws, req) => {
  const origin = req.headers.origin;
  const allowed = ['https://faucet.yourdomain.com'];
  if (!allowed.includes(origin)) {
    ws.close(1008, 'Origin not allowed');
    return;
  }
  // ... rest of handler
});
```

---

### 4. Missing Input Validation on WebSocket `counter`

**File:** `server/server.js:543-544`

```js
const { sessionId, counter } = message;
if (!sessionId || counter === undefined) {
```

The `counter` field only checks for `undefined`. The following values pass validation: `null`, `NaN`, negative numbers, strings, objects. The subsequent comparison behaves unpredictably with non-numeric types:

```js
// server/server.js:588
if (counter <= session.last_counter) {  // NaN <= anything is always false
```

A `NaN` counter would bypass the staleness check entirely, and a negative counter could produce unexpected hash inputs.

**Recommendation:**
```js
if (!sessionId || typeof counter !== 'number' || !Number.isInteger(counter) || counter < 0) {
  ws.send(JSON.stringify({ type: 'error', error: 'Invalid sessionId or counter' }));
  return;
}
```

---

### 5. Unauthenticated Information Disclosure via `/api/health`

**File:** `server/server.js:478-498`

```js
app.get('/api/health', async (req, res) => {
  const balance = await btqRPC('getbalance');
  const walletInfo = await btqRPC('getwalletinfo');

  res.json({
    status: 'ok',
    balance: balance,            // Exact wallet balance
    walletLoaded: true,
    walletUnlocked: !walletInfo.unlocked_until || walletInfo.unlocked_until > 0
  });
});
```

This endpoint requires no authentication and exposes:
- Exact faucet wallet balance (useful for timing drain attacks)
- Wallet lock/unlock status (useful for determining when the faucet can/cannot send)
- RPC connectivity status

**Recommendation:**
- Return only `{ status: 'ok' }` to unauthenticated callers
- Move detailed health info behind an API key or restrict to localhost/monitoring IPs
- The nginx config already has `access_log off` for this endpoint, but the data itself is the problem

---

## Medium Severity Issues

### 6. No Content-Security-Policy Header

**Files:** `server/server.js` (Express app), `nginx/faucet.conf`

Neither the Express app nor the nginx config sets a `Content-Security-Policy` header. A CSP would mitigate most XSS exploitation even if injection vulnerabilities exist.

The app loads external resources from:
- `fonts.googleapis.com` / `fonts.gstatic.com` (Google Fonts)
- `js.hcaptcha.com` / `newassets.hcaptcha.com` (hCaptcha)
- `cdn.jsdelivr.net` (js-sha256 in the web worker)

**Recommended CSP:**
```
Content-Security-Policy:
  default-src 'self';
  script-src 'self' https://js.hcaptcha.com https://cdn.jsdelivr.net;
  style-src 'self' 'unsafe-inline' https://fonts.googleapis.com;
  font-src https://fonts.gstatic.com;
  frame-src https://newassets.hcaptcha.com;
  connect-src 'self' wss: ws:;
  img-src 'self' data:;
  worker-src 'self';
```

Add this in both nginx (as a fallback) and Express (via `helmet` middleware or manually).

---

### 7. External Script Without Subresource Integrity (SRI)

**File:** `web/worker.js:2`

```js
importScripts('https://cdn.jsdelivr.net/npm/js-sha256@0.11.0/build/sha256.min.js');
```

This loads a JavaScript library from a CDN without SRI verification. If jsdelivr is compromised or serves tampered content, the mining worker's SHA-256 implementation could be replaced, allowing:
- Fake proof-of-work (submit shares without real computation)
- Session ID / nonce exfiltration via crafted WebSocket messages

**File:** `web/index.html:15`

```html
<script src="https://js.hcaptcha.com/1/api.js?render=explicit" async defer></script>
```

Third-party script with full main-thread access and no SRI (impractical for hCaptcha since they update frequently, but should be constrained by CSP).

**Recommendation:**
- Bundle `js-sha256` locally instead of loading from CDN, or add SRI:
  ```js
  // Better: bundle the file as web/sha256.min.js
  importScripts('./sha256.min.js');
  ```
- Constrain third-party scripts via CSP (see issue #6)

---

### 8. Raw Error Messages Leaked to Client

**File:** `server/server.js:305, 357, 474`

Multiple endpoints pass raw `error.message` to the client:

```js
catch (error) {
  console.error('Start mining error:', error);
  res.status(500).json({ error: error.message });  // Raw internal error
}
```

RPC errors can reveal:
- File paths on the server
- Wallet names and RPC configuration
- Database error details
- Node.js internal error strings

**Recommendation:**
```js
catch (error) {
  console.error('Start mining error:', error);
  res.status(500).json({ error: 'Internal server error' });
}
```

Return generic messages to the client. Log the real error server-side only.

---

### 9. RPC Password Defaults to Empty String

**File:** `server/server.js:15`

```js
RPC_PASS: process.env.RPC_PASS || '',
```

If `RPC_PASS` is not set in `.env`, the server connects to the RPC node with an empty password. If the node allows passwordless authentication (or has a matching empty password), this silently works — but means anyone who can reach the RPC port can interact with the wallet.

**Recommendation:**
- Fail hard on startup if `RPC_PASS` is not set:
  ```js
  if (!process.env.RPC_PASS) {
    console.error('FATAL: RPC_PASS environment variable is required');
    process.exit(1);
  }
  ```

---

## Low Severity Issues

### 10. Floating Point Arithmetic for Financial Values

**Files:** `server/server.js:100-101, 218, 426`

```js
// server/server.js:101
return (activeSeconds / 60) * CONFIG.REWARD_PER_MINUTE;

// server/server.js:218
outputs[changeAddress] = parseFloat(change.toFixed(8));
```

JavaScript floating point (IEEE 754 doubles) introduces rounding errors. For a testnet faucet this is tolerable, but could cause:
- Incorrect change amounts leading to stuck transactions
- Rounding discrepancies between accrued and claimed amounts

**Recommendation:** For production use, convert to integer satoshi arithmetic (multiply by 1e8, use integer math, convert back).

---

### 11. IP Salt Regenerated on Restart

**File:** `server/server.js:26`

```js
IP_SALT: process.env.IP_SALT || crypto.randomBytes(32).toString('hex'),
```

If `IP_SALT` is not set in `.env`, a new random salt is generated on every server restart. This means IP hashes in the database become inconsistent across restarts, breaking any future IP-based abuse detection.

**Recommendation:** Require `IP_SALT` in `.env` or generate and persist it on first run.

---

## What's Done Well

| Area | Detail |
|------|--------|
| SQL injection prevention | All database queries use parameterized prepared statements via `better-sqlite3` |
| Session ID entropy | 128-bit random session IDs (`crypto.randomBytes(16)`) — sufficient |
| Proof-of-work verification | Server-side SHA-256 verification prevents fake shares |
| systemd hardening | `NoNewPrivileges`, `ProtectSystem=strict`, `ProtectHome`, `PrivateTmp`, resource limits |
| nginx TLS config | Modern cipher suite, HSTS, TLSv1.2+ only, hidden file denial |
| IP privacy | IPs are hashed before storage (salted SHA-256) — no raw IPs in the database |
| Address validation | Regex-based validation on both client and server side |
| Graceful shutdown | SIGINT handler closes DB connection cleanly |

---

## Remediation Priority

| Priority | Issue | Effort |
|----------|-------|--------|
| **P0** | Fix XSS: replace `innerHTML` with `textContent` / DOM API | Small |
| **P0** | Add rate limiting (express-rate-limit + WebSocket limits) | Medium |
| **P1** | Add Content-Security-Policy header | Small |
| **P1** | Validate WebSocket `counter` type and range | Small |
| **P1** | Validate WebSocket `Origin` header | Small |
| **P2** | Sanitize server error responses (generic messages to client) | Small |
| **P2** | Bundle js-sha256 locally or add SRI hash | Small |
| **P2** | Restrict `/api/health` to authenticated callers | Small |
| **P2** | Require `RPC_PASS` on startup | Small |
| **P3** | Integer satoshi arithmetic | Medium |
| **P3** | Persist IP salt on first run | Small |
