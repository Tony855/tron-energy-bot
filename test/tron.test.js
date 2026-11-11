const test = require('node:test');
const assert = require('node:assert/strict');
const { validateAddress, rawToDecimal, decimalToRaw, matchWithdrawalTransfer, extractTrxTransfers } = require('../src/tron');

test('validates known TRON mainnet address checksum', () => {
  assert.equal(validateAddress('TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'), true);
});

test('rejects malformed and checksum-invalid addresses', () => {
  assert.equal(validateAddress('not-an-address'), false);
  assert.equal(validateAddress('TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6X'), false);
  assert.equal(validateAddress(''), false);
});

test('converts raw token values exactly without floating point', () => {
  assert.equal(rawToDecimal('1234567', 6), '1.234567');
  assert.equal(rawToDecimal('1000000', 6), '1');
  assert.equal(rawToDecimal('0', 6), '0');
  assert.equal(rawToDecimal('1', 6), '0.000001');
});

test('supports zero-decimal assets', () => {
  assert.equal(rawToDecimal('42', 0), '42');
});


test('converts decimal USDT amounts to raw integer units without floating point', () => {
  assert.equal(decimalToRaw('1.234567', 6), '1234567');
  assert.equal(decimalToRaw('10', 6), '10000000');
  assert.throws(() => decimalToRaw('1.0000001', 6), /精度/);
  assert.throws(() => decimalToRaw('-1', 6), /金额格式/);
});

test('withdrawal chain matching requires exact contract, recipient and amount', () => {
  const transfer = { confirmed: true, contract: 'contract', to: 'recipient', rawAmount: '5000000', from: 'sender' };
  assert.equal(matchWithdrawalTransfer([transfer], { contract: 'contract', to: 'recipient', rawAmount: '5000000' }), transfer);
  assert.throws(() => matchWithdrawalTransfer([transfer], { contract: 'wrong', to: 'recipient', rawAmount: '5000000' }), /不一致/);
  assert.throws(() => matchWithdrawalTransfer([transfer], { contract: 'contract', to: 'recipient', rawAmount: '5000001' }), /不一致/);
  assert.throws(() => matchWithdrawalTransfer([transfer], { contract: 'Contract', to: 'recipient', rawAmount: '5000000' }), /不一致/);
  assert.throws(() => matchWithdrawalTransfer([transfer], { contract: 'contract', to: 'Recipient', rawAmount: '5000000' }), /不一致/);
  assert.throws(() => matchWithdrawalTransfer([transfer, transfer], { contract: 'contract', to: 'recipient', rawAmount: '5000000' }), /多个匹配/);
});


test('extracts confirmed native TRX transfers and converts hex addresses', () => {
  const wallet = 'TJRabPrwbZy45sbavfcjinPJC18kjpRTv8';
  const good = {
    txID: 'a'.repeat(64), block_timestamp: 1700000000000,
    ret: [{ contractRet: 'SUCCESS' }],
    raw_data: { contract: [{ type: 'TransferContract', parameter: { value: {
      owner_address: wallet, to_address: 'TQn9Y2khEsLJW1ChVWFMSMeRDow5KcbLSE', amount: 2500000
    } } }] }
  };
  const failed = {
    txID: 'b'.repeat(64), ret: [{ contractRet: 'REVERT' }],
    raw_data: { contract: [{ type: 'TransferContract', parameter: { value: {
      owner_address: wallet, to_address: 'TQn9Y2khEsLJW1ChVWFMSMeRDow5KcbLSE', amount: 1000000
    } } }] }
  };
  const result = extractTrxTransfers({ data: [good, failed] }, wallet);
  assert.equal(result.length, 1);
  assert.equal(result[0].amount, '2.5');
  assert.equal(result[0].contract, 'TRX_NATIVE');
  assert.equal(result[0].eventIndex, -1);
});
