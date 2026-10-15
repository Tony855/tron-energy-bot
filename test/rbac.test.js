const test = require('node:test');
const assert = require('node:assert/strict');
const { canAccess, permissionFor, VALID_ROLES } = require('../src/rbac');

test('known roles are explicit and invalid roles fail closed', () => {
  assert.deepEqual(VALID_ROLES, ['super_admin', 'finance', 'operator', 'auditor']);
  assert.equal(canAccess('unknown', 'GET', '/api/users'), false);
  assert.equal(canAccess('auditor', 'POST', '/api/deposits/1/approve'), false);
});

test('finance can review funds but cannot manage admin accounts or operational wallets', () => {
  assert.equal(canAccess('finance', 'POST', '/api/deposits/1/approve'), true);
  assert.equal(canAccess('finance', 'POST', '/api/withdrawals/1/paid'), true);
  assert.equal(canAccess('finance', 'POST', '/api/admins'), false);
  assert.equal(canAccess('finance', 'POST', '/api/deposit-address-pool/import'), false);
});

test('operator can manage address pool and alerts but not approve money movements', () => {
  assert.equal(canAccess('operator', 'POST', '/api/deposit-address-pool/import'), true);
  assert.equal(canAccess('operator', 'POST', '/api/chain-alerts/run'), true);
  assert.equal(canAccess('operator', 'GET', '/api/withdrawals'), false);
  assert.equal(canAccess('operator', 'POST', '/api/deposits/2/approve'), false);
  assert.equal(canAccess('operator', 'POST', '/api/withdrawals/2/paid'), false);
});

test('auditor is read-only and cannot trigger report snapshots', () => {
  assert.equal(canAccess('auditor', 'GET', '/api/finance-audit'), true);
  assert.equal(canAccess('auditor', 'GET', '/api/ledger/export.csv'), true);
  assert.equal(canAccess('operator', 'GET', '/api/ledger/export.csv'), false);
  assert.equal(canAccess('auditor', 'POST', '/api/reconciliation/snapshot'), false);
  assert.equal(canAccess('auditor', 'GET', '/api/admins'), false);
});

test('unmapped endpoints are default-denied except super admin', () => {
  assert.equal(permissionFor('DELETE', '/api/users/1'), 'deny');
  assert.equal(canAccess('finance', 'DELETE', '/api/users/1'), false);
  assert.equal(canAccess('super_admin', 'DELETE', '/api/users/1'), true);
});
