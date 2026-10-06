'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const BTQAddress = require('../../web/btq-address.js');
const { encodeSegwit } = require('./support/bech32-encode.js');

const P2MR = 'tbtq1zqtr809hratgku9hsyxah7eejenjhqv09hx0m72wwr6hxd4nk6mtq0eh00m';
// P2MR_LIVE_PROGRAM must equal the program in this address's mined scriptPubKey (5220 || program).
const P2MR_LIVE = 'tbtq1zek5r5xh6e52qny5vj6xd6usdpur6x9qt6yxuzddgnekdnwfxwcvqz7qmm2';
const P2MR_LIVE_PROGRAM = 'cda83a1afacd1409928c968cdd720d0f07a3140bd10dc135a89e6cd9b9267618';
const P2WPKH = 'tbtq1qw508d6qejxtdg4y5r3zarvary0c5xw7kkau9tj';
const P2WSH = 'tbtq1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3qtgnmgf';
const REGTEST_P2MR = 'qcrt1zqtr809hratgku9hsyxah7eejenjhqv09hx0m72wwr6hxd4nk6mtqwd2c2u';
const DILITHIUM_BASE58_LONG = 'nTb8m' + '1'.repeat(45);
const DILITHIUM_P2PKH = 'nFXpqKGstGktjrogxmR28tu6ccJCfGSTEk';
const LEGACY_P2PKH = 'mrCDrCybB6J1vRfbwM5hemdJz73FwDBC8r';
const MAINNET_LOOKING = 'btq1qw508d6qejxtdg4y5r3zarvary0c5xw7kp0lvcc';

test('accepts testnet P2MR addresses', () => {
  assert.equal(BTQAddress.getAddressType(P2MR), 'p2mr');
  assert.equal(BTQAddress.getAddressType(P2MR_LIVE), 'p2mr');
});

test('decodes P2MR to the witness program used in the output script', () => {
  const decoded = BTQAddress.decodeSegwit(P2MR_LIVE, 'tbtq');
  assert.equal(decoded.version, 2);
  assert.equal(Buffer.from(decoded.program).toString('hex'), P2MR_LIVE_PROGRAM);
});

test('keeps accepting the formats the faucet already took', () => {
  assert.equal(BTQAddress.getAddressType(P2WPKH), 'segwit');
  assert.equal(BTQAddress.getAddressType(P2WSH), 'segwit');
  assert.equal(BTQAddress.getAddressType(DILITHIUM_BASE58_LONG), 'dilithium');
  assert.equal(BTQAddress.getAddressType(DILITHIUM_P2PKH), 'legacy');
  assert.equal(BTQAddress.getAddressType(LEGACY_P2PKH), 'legacy');
});

test('rejects strings that break bech32/bech32m rules', () => {
  const invalid = {
    badChecksum: 'tbtq1zqtr809hratgku9hsyxah7eejenjhqv09hx0m72wwr6hxd4nk6mtq0eh00n',
    mixedCase: 'Tbtq1zqtr809hratgku9hsyxah7eejenjhqv09hx0m72wwr6hxd4nk6mtq0eh00m',
    p2mrWithBech32Checksum: 'tbtq1zqtr809hratgku9hsyxah7eejenjhqv09hx0m72wwr6hxd4nk6mtq698r2e',
    v0WithBech32mChecksum: 'tbtq1qw508d6qejxtdg4y5r3zarvary0c5xw7krpvfws',
    nonZeroPadding: 'tbtq1zqtr809hratgku9hsyxah7eejenjhqv09hx0m72wwr6hxd4nk6mtpj0r6jf',
    tooLong: 'tbtq1z' + 'q'.repeat(90),
  };
  for (const [name, address] of Object.entries(invalid)) {
    assert.equal(BTQAddress.getAddressType(address), null, name);
  }
});

test('rejects non-ASCII look-alikes instead of case-folding them', () => {
  // U+212A KELVIN SIGN lowercases to "k"; BIP173 and btq-core reject anything outside ASCII 33-126.
  const kelvin = P2MR.toUpperCase().replace('K', '\u212A');
  assert.equal(BTQAddress.getAddressType(kelvin), null);
  assert.equal(BTQAddress.normalizeAddress(kelvin), null);
});

test('rejects witness programs the faucet does not pay', () => {
  assert.equal(BTQAddress.getAddressType('tbtq1zw508d6qejxtdg4y5r3zarvary0c5xw7k45tl5x'), null, 'v2 with 20 bytes');
  assert.equal(BTQAddress.getAddressType('tbtq1pqtr809hratgku9hsyxah7eejenjhqv09hx0m72wwr6hxd4nk6mtq8ywqps'), null, 'v1 taproot');
});

test('rejects addresses for other networks', () => {
  for (const address of [
    MAINNET_LOOKING,
    'qbtc1zqtr809hratgku9hsyxah7eejenjhqv09hx0m72wwr6hxd4nk6mtq2vu844',
    'tdbt1zqtr809hratgku9hsyxah7eejenjhqv09hx0m72wwr6hxd4nk6mtqej84ux',
    REGTEST_P2MR,
  ]) {
    assert.equal(BTQAddress.getAddressType(address), null, address);
  }
});

test('validates against the configured HRP', () => {
  assert.equal(BTQAddress.getAddressType(REGTEST_P2MR, { hrp: 'qcrt' }), 'p2mr');
  assert.equal(BTQAddress.getAddressType(P2MR, { hrp: 'qcrt' }), null);
  assert.equal(BTQAddress.getAddressType(P2MR, { hrp: 'TBTQ' }), 'p2mr');
});

test('rejects non-strings and empty input', () => {
  for (const value of [undefined, null, 42, {}, [], '', '   ']) {
    assert.equal(BTQAddress.getAddressType(value), null);
    assert.equal(BTQAddress.normalizeAddress(value), null);
  }
});

test('normalizes bech32 to lowercase and trims, leaves base58 untouched', () => {
  assert.equal(BTQAddress.normalizeAddress(`  ${P2MR.toUpperCase()}\n`), P2MR);
  assert.equal(BTQAddress.normalizeAddress(P2WPKH.toUpperCase()), P2WPKH);
  assert.equal(BTQAddress.normalizeAddress(` ${LEGACY_P2PKH} `), LEGACY_P2PKH);
});

test('round-trips random P2MR programs', () => {
  for (let i = 0; i < 100; i++) {
    const program = crypto.randomBytes(32);
    const address = encodeSegwit('tbtq', 2, program, 'bech32m');
    assert.equal(address.length, 64);
    assert.ok(address.startsWith('tbtq1z'));
    assert.equal(BTQAddress.normalizeAddress(address), address);
    assert.deepEqual(Buffer.from(BTQAddress.decodeSegwit(address, 'tbtq').program), program);
    assert.equal(BTQAddress.getAddressType(encodeSegwit('tbtq', 2, program, 'bech32')), null);
  }
});

test('readAddressParam ignores links without an address', () => {
  assert.deepEqual(BTQAddress.readAddressParam(''), { status: 'none' });
  assert.deepEqual(BTQAddress.readAddressParam('?ref=wallet'), { status: 'none' });
  assert.deepEqual(BTQAddress.readAddressParam('?address='), { status: 'none' });
});

test('readAddressParam returns the normalized address from a valid link', () => {
  assert.deepEqual(BTQAddress.readAddressParam(`?address=${P2MR}`), { status: 'valid', address: P2MR });
  assert.deepEqual(BTQAddress.readAddressParam(`?address=%20${P2MR.toUpperCase()}`), { status: 'valid', address: P2MR });
  assert.deepEqual(BTQAddress.readAddressParam(`?address=${REGTEST_P2MR}`, { hrp: 'qcrt' }), { status: 'valid', address: REGTEST_P2MR });
});

test('readAddressParam flags invalid addresses without echoing them', () => {
  assert.deepEqual(BTQAddress.readAddressParam('?address=%3Cscript%3Ealert(1)%3C%2Fscript%3E'), { status: 'invalid' });
  assert.deepEqual(BTQAddress.readAddressParam(`?address=${MAINNET_LOOKING}`), { status: 'invalid' });
});
