// SHA-256 library — bundled locally to avoid CDN supply chain risk
importScripts('./sha256.min.js');

let stopped = false;
let currentDifficulty = 0;
let target = '';
let nonce = '';
let address = '';
let counter = 0;
let startTime = 0;
let lastReport = 0;

function setDifficulty(difficulty) {
  currentDifficulty = difficulty;
  target = '0'.repeat(difficulty);
}

function resetMining(params) {
  nonce = params.nonce;
  address = params.address;
  counter = 0;
  stopped = false;
  startTime = Date.now();
  lastReport = startTime;
  setDifficulty(params.difficulty);
}

function reportProgress() {
  const elapsed = (Date.now() - startTime) / 1000;
  const hashRate = elapsed > 0 ? Math.floor(counter / elapsed) : 0;

  self.postMessage({
    type: 'progress',
    counter,
    hashRate
  });
}

function mineStep() {
  if (stopped) {
    return;
  }

  const batchSize = 10000;
  for (let i = 0; i < batchSize; i++) {
    const input = `${nonce}:${address}:${counter}`;
    const hash = sha256(input);

    if (hash.startsWith(target)) {
      const elapsed = Date.now() - startTime;
      const hashRate = elapsed > 0 ? Math.floor(counter / (elapsed / 1000)) : 0;

      self.postMessage({
        type: 'share',
        counter,
        hashRate
      });
    }

    counter++;

    if (stopped) {
      break;
    }
  }

  const now = Date.now();
  if (counter % 100000 === 0 || now - lastReport > 2000) {
    reportProgress();
    lastReport = now;
  }

  setTimeout(mineStep, 0);
}

self.addEventListener('message', (e) => {
  const message = e.data || {};

  if (message.type === 'start') {
    resetMining(message);
    reportProgress();
    mineStep();
    return;
  }

  if (message.type === 'stop') {
    stopped = true;
    return;
  }

  if (message.type === 'difficulty') {
    setDifficulty(message.difficulty);
  }
});
