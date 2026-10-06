(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.BTQAddress = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const DEFAULT_HRP = 'tbtq';
  const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
  const GENERATOR = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  const BECH32_CONST = 1;
  const BECH32M_CONST = 0x2bc830a3;
  const MAX_LENGTH = 90;
  const P2MR_VERSION = 2;
  const P2MR_PROGRAM_BYTES = 32;
  // server.js picks the signing RPC for the faucet's own UTXOs from these labels; keep them as they were.
  const DILITHIUM_BASE58 = /^[nd][1-9A-HJ-NP-Za-km-z]{40,60}$/;
  const LEGACY_BASE58 = /^[mMnNB][1-9A-HJ-NP-Za-km-z]{25,34}$/;

  function polymod(values) {
    let chk = 1;
    for (const value of values) {
      const top = chk >>> 25;
      chk = ((chk & 0x1ffffff) << 5) ^ value;
      for (let i = 0; i < 5; i++) {
        if ((top >>> i) & 1) chk ^= GENERATOR[i];
      }
    }
    return chk;
  }

  function hrpExpand(hrp) {
    const high = [];
    const low = [];
    for (let i = 0; i < hrp.length; i++) {
      high.push(hrp.charCodeAt(i) >> 5);
      low.push(hrp.charCodeAt(i) & 31);
    }
    return high.concat([0], low);
  }

  function decodeBech32(str) {
    if (str.length > MAX_LENGTH) return null;
    // Before any case folding: toLowerCase() maps some non-ASCII letters onto the charset (U+212A -> "k").
    for (let i = 0; i < str.length; i++) {
      const code = str.charCodeAt(i);
      if (code < 33 || code > 126) return null;
    }
    const lower = str.toLowerCase();
    if (str !== lower && str !== str.toUpperCase()) return null;
    const pos = lower.lastIndexOf('1');
    if (pos < 1 || pos + 7 > lower.length) return null;
    const hrp = lower.slice(0, pos);
    const data = [];
    for (let i = pos + 1; i < lower.length; i++) {
      const value = CHARSET.indexOf(lower[i]);
      if (value === -1) return null;
      data.push(value);
    }
    const check = polymod(hrpExpand(hrp).concat(data));
    let encoding;
    if (check === BECH32_CONST) encoding = 'bech32';
    else if (check === BECH32M_CONST) encoding = 'bech32m';
    else return null;
    return { hrp, words: data.slice(0, -6), encoding };
  }

  function wordsToBytes(words) {
    let acc = 0;
    let bits = 0;
    const bytes = [];
    for (const word of words) {
      acc = (acc << 5) | word;
      bits += 5;
      if (bits >= 8) {
        bits -= 8;
        bytes.push((acc >> bits) & 0xff);
      }
      acc &= (1 << bits) - 1;
    }
    if (bits >= 5 || acc !== 0) return null;
    return bytes;
  }

  function decodeSegwit(address, hrp) {
    if (typeof address !== 'string') return null;
    const decoded = decodeBech32(address);
    if (!decoded || decoded.hrp !== String(hrp).toLowerCase() || decoded.words.length === 0) return null;
    const version = decoded.words[0];
    if (version > 16) return null;
    const program = wordsToBytes(decoded.words.slice(1));
    if (!program || program.length < 2 || program.length > 40) return null;
    if (version === 0) {
      if (decoded.encoding !== 'bech32' || (program.length !== 20 && program.length !== 32)) return null;
    } else if (decoded.encoding !== 'bech32m') {
      return null;
    }
    return { version, program };
  }

  function getAddressType(address, options) {
    if (typeof address !== 'string') return null;
    const hrp = (options && options.hrp) || DEFAULT_HRP;
    const segwit = decodeSegwit(address, hrp);
    if (segwit) {
      if (segwit.version === 0) return 'segwit';
      if (segwit.version === P2MR_VERSION && segwit.program.length === P2MR_PROGRAM_BYTES) return 'p2mr';
      return null;
    }
    if (DILITHIUM_BASE58.test(address)) return 'dilithium';
    if (LEGACY_BASE58.test(address)) return 'legacy';
    return null;
  }

  function normalizeAddress(address, options) {
    if (typeof address !== 'string') return null;
    const trimmed = address.trim();
    const type = getAddressType(trimmed, options);
    if (!type) return null;
    return type === 'segwit' || type === 'p2mr' ? trimmed.toLowerCase() : trimmed;
  }

  function readAddressParam(search, options) {
    const raw = new URLSearchParams(search).get('address');
    if (raw === null || raw.trim() === '') return { status: 'none' };
    const address = normalizeAddress(raw, options);
    return address ? { status: 'valid', address } : { status: 'invalid' };
  }

  return { DEFAULT_HRP, decodeSegwit, getAddressType, normalizeAddress, readAddressParam };
});
