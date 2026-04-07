// Application State
const AppState = {
  READY: 'ready',
  MINING: 'mining',
  CLAIMABLE: 'claimable',
  CLAIMED: 'claimed'
};

// State
let currentState = AppState.READY;
let miningWorker = null;
let miningActive = false;
let ws = null;
let currentSession = null;
let currentDifficulty = 0;
let activeSeconds = 0;
let accrued = 0;
let minClaim = 0.01;
let currentAddress = '';
let captchaToken = null;
let captchaEnabled = false;

// DOM Elements - Sections
const stateReady = document.getElementById('state-ready');
const stateMining = document.getElementById('state-mining');
const stateClaimable = document.getElementById('state-claimable');
const stateClaimed = document.getElementById('state-claimed');

// DOM Elements - Ready state
const addressInput = document.getElementById('address');
const startBtn = document.getElementById('start-btn');

// DOM Elements - Mining state
const addressBadge = document.getElementById('address-badge');
const miningHero = document.getElementById('mining-hero');
const accruedAmount = document.getElementById('accrued-amount');
const progressFill = document.getElementById('progress-fill');
const progressLabel = document.getElementById('progress-label');
const hashRateEl = document.getElementById('hash-rate');
const difficultyEl = document.getElementById('difficulty');
const attemptsEl = document.getElementById('attempts');
const activeTimeEl = document.getElementById('active-time');
const stopBtn = document.getElementById('stop-btn');

// DOM Elements - Claimable state
const successCard = document.getElementById('success-card');
const finalAmount = document.getElementById('final-amount');
const timeSpent = document.getElementById('time-spent');
const claimBtn = document.getElementById('claim-btn');
const mineMoreBtn = document.getElementById('mine-more-btn');

// DOM Elements - Claimed state
const newSessionBtn = document.getElementById('new-session-btn');

// DOM Elements - Messages
const messageEl = document.getElementById('message');
const messageText = document.getElementById('message-text');

// Address Validation
// BTQ address formats (from btq-core chainparams.cpp):
// - Dilithium base58: 'n' (testnet/signet/regtest), 'd' (mainnet) — ~50 chars
// - Dilithium bech32: HRP 'tdbt' (testnet), 'sdbt' (signet), 'rdbt' (regtest), 'dbtc' (mainnet)
// - SegWit bech32: HRP 'tbtq' (testnet), 'qtb' (signet), 'qcrt' (regtest), 'qbtc' (mainnet)
// - Legacy base58: 'm'/'n' (testnet/signet/regtest), 'B' (mainnet) — 25-34 chars
function isValidBTQAddress(address) {
  if (!address || typeof address !== 'string') return false;

  // Dilithium base58 addresses (longer ~50 chars)
  if (/^[nd][a-km-zA-HJ-NP-Z1-9]{40,60}$/.test(address)) {
    return true;
  }

  // Dilithium bech32 addresses (HRP: tdbt, sdbt, rdbt, dbtc)
  if (/^(tdbt|sdbt|rdbt|dbtc)1[a-z0-9]{38,}$/.test(address)) {
    return true;
  }

  // SegWit bech32 addresses (HRP: tbtq, qtb, qcrt, qbtc)
  if (/^(tbtq|qtb|qcrt|qbtc)1q[a-z0-9]{38,}$/.test(address)) {
    return true;
  }

  // Legacy base58 addresses (shorter)
  if (/^[mMnNB][a-km-zA-HJ-NP-Z1-9]{25,34}$/.test(address)) {
    return true;
  }

  return false;
}

// State Management
function setState(newState) {
  currentState = newState;

  // Hide all state sections
  stateReady.classList.remove('active');
  stateMining.classList.remove('active');
  stateClaimable.classList.remove('active');
  stateClaimed.classList.remove('active');

  // Show the active section
  switch (newState) {
    case AppState.READY:
      stateReady.classList.add('active');
      addressInput.disabled = false;
      // Only enable start button if captcha is verified (or captcha is disabled)
      startBtn.disabled = captchaEnabled && !captchaToken;
      startBtn.innerHTML = 'Start Mining';
      // Reset captcha when returning to ready state
      if (typeof hcaptcha !== 'undefined' && captchaEnabled) {
        hcaptcha.reset();
        captchaToken = null;
      }
      break;

    case AppState.MINING:
      stateMining.classList.add('active');
      miningHero.classList.add('pulse');
      break;

    case AppState.CLAIMABLE:
      stateClaimable.classList.add('active');
      updateClaimableUI();
      break;

    case AppState.CLAIMED:
      stateClaimed.classList.add('active');
      break;
  }
}

// Utilities
function truncateAddress(address) {
  if (!address || address.length < 12) return address;
  return `${address.slice(0, 8)}...${address.slice(-6)}`;
}

function formatSeconds(totalSeconds) {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${seconds}s`;
}

function formatBTQ(amount) {
  return amount.toFixed(4);
}

// UI Updates
function updateMiningStats() {
  accruedAmount.textContent = formatBTQ(accrued);
  difficultyEl.textContent = '0'.repeat(currentDifficulty) + '...';
  activeTimeEl.textContent = formatSeconds(activeSeconds);

  // Update progress bar (progress toward minClaim)
  const progressPercent = Math.min((accrued / minClaim) * 100, 100);
  progressFill.style.width = `${progressPercent}%`;
  progressLabel.textContent = `${Math.floor(progressPercent)}% to minimum claim (${minClaim} BTQ)`;
}

function updateClaimableUI() {
  finalAmount.textContent = `${formatBTQ(accrued)} BTQ`;
  timeSpent.textContent = `in ${formatSeconds(activeSeconds)}`;
  claimBtn.textContent = `Claim ${formatBTQ(accrued)} BTQ`;
  claimBtn.disabled = accrued < minClaim;

  if (accrued < minClaim) {
    claimBtn.textContent = `Need ${formatBTQ(minClaim - accrued)} more BTQ to claim`;
  }
}

function setButtonLoading(button, loading, loadingText = '') {
  if (loading) {
    button.disabled = true;
    button.dataset.originalText = button.innerHTML;
    button.innerHTML = `<span class="spinner"></span>${loadingText ? ' ' + loadingText : ''}`;
  } else {
    button.disabled = false;
    button.innerHTML = button.dataset.originalText || button.innerHTML;
  }
}

// Messages
function showMessage(text, type = 'error') {
  messageText.innerHTML = text;
  messageEl.className = `message ${type} show`;
}

function dismissMessage() {
  messageEl.classList.remove('show');
}

function showSuccess(txid) {
  showMessage(`
    Transaction sent successfully!<br>
    <a href="https://explorer.bitcoinquantum.com/tx/${txid}" target="_blank" style="word-break: break-all; font-size: 12px;">View on Block Explorer</a>
  `, 'success');
}

function showError(message, actionable = null) {
  let html = message;
  if (actionable) {
    html += ` <a href="#" onclick="${actionable.action}; return false;">${actionable.text}</a>`;
  }
  showMessage(html, 'error');
}

// API Functions
function connectWebSocket() {
  return new Promise((resolve, reject) => {
    const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const socket = new WebSocket(`${protocol}://${window.location.host}/ws`);

    socket.addEventListener('open', () => resolve(socket));
    socket.addEventListener('error', (event) => reject(event));
  });
}

async function startSession(address) {
  const body = { address };

  // Include captcha token if captcha is enabled
  if (captchaEnabled && captchaToken) {
    body.captchaToken = captchaToken;
  }

  const response = await fetch('/api/mining/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || 'Failed to start mining');
  }

  return data;
}

async function stopSession(sessionId) {
  const response = await fetch('/api/mining/stop', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId })
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || 'Failed to stop mining');
  }

  return data;
}

async function claimSession(sessionId) {
  const response = await fetch('/api/mining/claim', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId })
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || 'Failed to claim');
  }

  return data;
}

// Worker Management
function createWorker(session, address) {
  miningWorker = new Worker('worker.js');

  miningWorker.addEventListener('message', (event) => {
    const { type, counter, hashRate } = event.data;

    if (type === 'progress') {
      hashRateEl.textContent = `${hashRate.toLocaleString()} H/s`;
      attemptsEl.textContent = counter.toLocaleString();
    }

    if (type === 'share') {
      hashRateEl.textContent = `${hashRate.toLocaleString()} H/s`;
      attemptsEl.textContent = counter.toLocaleString();

      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: 'share',
          sessionId: session.sessionId,
          counter
        }));
      }
    }
  });

  miningWorker.postMessage({
    type: 'start',
    nonce: session.nonce,
    address,
    difficulty: session.difficulty
  });
}

function stopWorker() {
  if (miningWorker) {
    miningWorker.postMessage({ type: 'stop' });
    miningWorker.terminate();
    miningWorker = null;
  }
}

function closeWebSocket() {
  if (ws) {
    ws.close();
    ws = null;
  }
}

// Mining Flow
async function startMining() {
  const address = addressInput.value.trim();

  if (!address) {
    showError('Please enter a BTQ address.');
    return;
  }

  if (!isValidBTQAddress(address)) {
    showError('Invalid BTQ address format.');
    return;
  }

  currentAddress = address;
  dismissMessage();
  setButtonLoading(startBtn, true, 'Connecting...');

  try {
    currentSession = await startSession(address);
    minClaim = currentSession.minClaim || minClaim;

    ws = await connectWebSocket();

    ws.addEventListener('close', () => {
      if (miningActive) {
        miningActive = false;
        stopWorker();
        miningHero.classList.remove('pulse');
        showError('Connection lost.', { text: 'Tap to retry', action: 'startMining()' });
        setState(AppState.READY);
      }
    });

    ws.addEventListener('error', () => {
      if (miningActive) {
        miningActive = false;
        stopWorker();
        miningHero.classList.remove('pulse');
        showError('Connection error.', { text: 'Tap to retry', action: 'startMining()' });
        setState(AppState.READY);
      }
    });

    ws.addEventListener('message', (event) => {
      const data = JSON.parse(event.data || '{}');

      if (data.type === 'accepted') {
        activeSeconds = data.activeSeconds;
        accrued = data.accrued;
        if (data.difficulty !== currentDifficulty) {
          currentDifficulty = data.difficulty;
          if (miningWorker) {
            miningWorker.postMessage({
              type: 'difficulty',
              difficulty: currentDifficulty
            });
          }
        }
        updateMiningStats();
      }

      if (data.type === 'session_complete') {
        miningActive = false;
        stopWorker();
        closeWebSocket();
        activeSeconds = data.activeSeconds;
        accrued = data.accrued;
        updateMiningStats();
        miningHero.classList.remove('pulse');
        showMessage(data.message || 'Session complete');
        setState(AppState.CLAIMABLE);
      }

      if (data.type === 'error') {
        miningActive = false;
        stopWorker();
        closeWebSocket();
        showError(data.error);
        setState(AppState.READY);
      }
    });

    // Initialize mining state
    miningActive = true;
    currentDifficulty = currentSession.difficulty;
    activeSeconds = 0;
    accrued = 0;

    // Update UI
    addressBadge.textContent = truncateAddress(address);
    updateMiningStats();
    setState(AppState.MINING);

    // Start the worker
    createWorker(currentSession, address);

  } catch (error) {
    miningActive = false;
    stopWorker();
    closeWebSocket();
    setButtonLoading(startBtn, false);
    showError(error.message);
  }
}

async function stopMining() {
  if (!currentSession) return;

  setButtonLoading(stopBtn, true, 'Stopping...');
  miningHero.classList.remove('pulse');

  // Set miningActive false BEFORE closing WebSocket to prevent "Connection lost" message
  miningActive = false;
  stopWorker();
  closeWebSocket();

  try {
    const data = await stopSession(currentSession.sessionId);

    activeSeconds = data.activeSeconds;
    accrued = data.accrued;
    currentDifficulty = data.difficulty;
    minClaim = data.minClaim || minClaim;

    setButtonLoading(stopBtn, false);
    setState(AppState.CLAIMABLE);

  } catch (error) {
    showError(error.message);
    setButtonLoading(stopBtn, false);
  }
}

async function claimRewards() {
  if (!currentSession) return;

  setButtonLoading(claimBtn, true, 'Claiming...');

  try {
    const result = await claimSession(currentSession.sessionId);
    const claimedAmount = accrued;

    // Update claimed state UI
    document.getElementById('claimed-amount').textContent = `${formatBTQ(claimedAmount)} BTQ`;
    document.getElementById('claimed-txid').href = `https://explorer.bitcoinquantum.com/tx/${result.txid}`;
    document.getElementById('claimed-txid').textContent = result.txid;

    // Reset for new session
    currentSession = null;
    accrued = 0;
    activeSeconds = 0;

    // Show claimed state
    setState(AppState.CLAIMED);

  } catch (error) {
    showError(error.message);
    setButtonLoading(claimBtn, false);
  }
}

function mineMore() {
  // Keep the session but go back to mining
  if (!currentSession) {
    setState(AppState.READY);
    return;
  }

  dismissMessage();
  startMiningWithSession();
}

async function startMiningWithSession() {
  setButtonLoading(mineMoreBtn, true, 'Resuming...');

  try {
    // Resume the session on the server first
    const resumeResponse = await fetch('/api/mining/resume', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: currentSession.sessionId })
    });

    if (!resumeResponse.ok) {
      const data = await resumeResponse.json();
      throw new Error(data.error || 'Failed to resume session');
    }

    ws = await connectWebSocket();

    ws.addEventListener('close', () => {
      if (miningActive) {
        miningActive = false;
        stopWorker();
        miningHero.classList.remove('pulse');
        showError('Connection lost.');
        setState(AppState.CLAIMABLE);
      }
    });

    ws.addEventListener('error', () => {
      if (miningActive) {
        miningActive = false;
        stopWorker();
        miningHero.classList.remove('pulse');
        showError('Connection error.');
        setState(AppState.CLAIMABLE);
      }
    });

    ws.addEventListener('message', (event) => {
      const data = JSON.parse(event.data || '{}');

      if (data.type === 'accepted') {
        activeSeconds = data.activeSeconds;
        accrued = data.accrued;
        if (data.difficulty !== currentDifficulty) {
          currentDifficulty = data.difficulty;
          if (miningWorker) {
            miningWorker.postMessage({
              type: 'difficulty',
              difficulty: currentDifficulty
            });
          }
        }
        updateMiningStats();
      }

      if (data.type === 'session_complete') {
        miningActive = false;
        stopWorker();
        closeWebSocket();
        activeSeconds = data.activeSeconds;
        accrued = data.accrued;
        updateMiningStats();
        miningHero.classList.remove('pulse');
        showMessage(data.message || 'Session complete');
        setState(AppState.CLAIMABLE);
      }

      if (data.type === 'error') {
        miningActive = false;
        stopWorker();
        closeWebSocket();
        showError(data.error);
        setState(AppState.CLAIMABLE);
      }
    });

    miningActive = true;
    updateMiningStats();
    setButtonLoading(mineMoreBtn, false);
    setState(AppState.MINING);

    createWorker(currentSession, currentAddress);

  } catch (error) {
    showError(error.message);
    setButtonLoading(mineMoreBtn, false);
  }
}

// Event Listeners
startBtn.addEventListener('click', (e) => {
  e.preventDefault();
  startMining();
});

addressInput.addEventListener('keypress', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    startMining();
  }
});

stopBtn.addEventListener('click', () => {
  stopMining();
});

claimBtn.addEventListener('click', () => {
  claimRewards();
});

mineMoreBtn.addEventListener('click', () => {
  mineMore();
});

newSessionBtn.addEventListener('click', () => {
  setState(AppState.READY);
});

// Cleanup on page unload
window.addEventListener('beforeunload', () => {
  stopWorker();
  closeWebSocket();
});

// hCaptcha callbacks (must be global)
window.onCaptchaVerified = function(token) {
  captchaToken = token;
  startBtn.disabled = false;
};

window.onCaptchaExpired = function() {
  captchaToken = null;
  startBtn.disabled = true;
};

// Initialize captcha and check health
async function initialize() {
  try {
    // Check for captcha configuration
    const configResponse = await fetch('/api/config');
    const config = await configResponse.json();

    if (config.captchaSiteKey) {
      captchaEnabled = true;
      // Wait for hCaptcha to load, then render explicitly
      const renderCaptcha = () => {
        const captchaContainer = document.querySelector('.h-captcha');
        if (captchaContainer) {
          hcaptcha.render(captchaContainer, {
            sitekey: config.captchaSiteKey,
            theme: 'dark',
            callback: 'onCaptchaVerified',
            'expired-callback': 'onCaptchaExpired'
          });
        }
      };

      if (typeof hcaptcha !== 'undefined') {
        renderCaptcha();
      } else {
        // Wait for hCaptcha script to load
        const checkInterval = setInterval(() => {
          if (typeof hcaptcha !== 'undefined') {
            clearInterval(checkInterval);
            renderCaptcha();
          }
        }, 100);
      }
      // Keep start button disabled until captcha is verified
      startBtn.disabled = true;
    } else {
      // No captcha configured, hide the container and enable button
      captchaEnabled = false;
      const captchaContainer = document.getElementById('captcha-container');
      if (captchaContainer) {
        captchaContainer.style.display = 'none';
      }
      startBtn.disabled = false;
    }

    // Health check
    const healthResponse = await fetch('/api/health');
    const health = await healthResponse.json();

    if (health.rpc !== 'ok') {
      showError('Faucet is currently offline. Please try again later.');
      startBtn.disabled = true;
    }
  } catch (error) {
    showError('Cannot connect to faucet server. Please try again later.');
    startBtn.disabled = true;
  }

  setState(AppState.READY);
}

// Initialize
initialize();
