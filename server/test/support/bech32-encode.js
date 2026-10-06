'use strict';

const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const GENERATOR = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];

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

function bytesToWords(bytes) {
  let acc = 0;
  let bits = 0;
  const words = [];
  for (const byte of bytes) {
    acc = ((acc << 8) | byte) & 0xfff;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      words.push((acc >> bits) & 31);
    }
  }
  if (bits > 0) words.push((acc << (5 - bits)) & 31);
  return words;
}

function encodeSegwit(hrp, version, program, encoding) {
  const data = [version].concat(bytesToWords(program));
  const expanded = [];
  for (const ch of hrp) expanded.push(ch.charCodeAt(0) >> 5);
  expanded.push(0);
  for (const ch of hrp) expanded.push(ch.charCodeAt(0) & 31);
  const mod = polymod(expanded.concat(data, [0, 0, 0, 0, 0, 0])) ^ (encoding === 'bech32m' ? 0x2bc830a3 : 1);
  const checksum = [];
  for (let i = 0; i < 6; i++) checksum.push((mod >>> (5 * (5 - i))) & 31);
  return hrp + '1' + data.concat(checksum).map((v) => CHARSET[v]).join('');
}

module.exports = { encodeSegwit };
