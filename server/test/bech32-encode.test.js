'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { encodeSegwit } = require('./support/bech32-encode.js');

test('reference encoder reproduces pinned vectors', () => {
  assert.equal(
    encodeSegwit('tbtq', 2, Buffer.from('02c67796e3ead16e16f021bb7f6732cce57031e5b99fbf29ce1eae66d676d6d6', 'hex'), 'bech32m'),
    'tbtq1zqtr809hratgku9hsyxah7eejenjhqv09hx0m72wwr6hxd4nk6mtq0eh00m'
  );
  assert.equal(
    encodeSegwit('tbtq', 0, Buffer.from('751e76e8199196d454941c45d1b3a323f1433bd6', 'hex'), 'bech32'),
    'tbtq1qw508d6qejxtdg4y5r3zarvary0c5xw7kkau9tj'
  );
});
