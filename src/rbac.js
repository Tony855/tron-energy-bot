'use strict';

const VALID_ROLES = Object.freeze(['super_admin', 'finance', 'operator', 'auditor']);

// Default deny: every API route must be explicitly assigned to a capability group.
function permissionFor(method, path) {
  const m = String(method || 'GET').toUpperCase();
  const p = String(path || '').split('?')[0];
  if (p === '/api/login' || p === '/health' || p === '/') return 'public';
  if (/^\/api\/admins(?:\/|$)/.test(p)) return 'admin_manage';
  if (m === 'GET' && p === '/api/dashboard') return 'dashboard';
  if (m === 'GET' && ['/api/deposits','/api/users','/api/withdrawals','/api/audit-logs','/api/commissions','/api/reconciliation/summary','/api/reconciliation/snapshots','/api/ledger/export.csv','/api/finance-audit'].includes(p)) return 'finance_read';
  if (m === 'GET' && ['/api/deposit-wallets','/api/deposit-address-pool'].includes(p)) return 'wallet_read';
  if (m === 'GET' && p === '/api/energy-orders') return 'operations_read';
  if (m === 'GET' && ['/api/chain-backfill/status','/api/chain-alerts/recent','/api/chain-audit','/api/events/status'].includes(p)) return 'chain_read';
  if (p === '/api/chain-backfill/run' && m === 'POST') return 'chain_ops';
  if (p === '/api/chain-alerts/run' && m === 'POST') return 'chain_ops';
  if (p === '/api/reconciliation/snapshot' && m === 'POST') return 'finance_write';
  if (p === '/api/deposit-address-pool/import' && m === 'POST') return 'wallet_write';
  if (/^\/api\/deposit-address-pool\/assign\/\d+$/.test(p) && m === 'POST') return 'wallet_write';
  if (p === '/api/wallets/deposit-address' && m === 'POST') return 'wallet_write';
  if (p === '/api/deposits/manual' && m === 'POST') return 'finance_write';
  if (/^\/api\/deposits\/\d+\/(verify-chain|approve|reject)$/.test(p) && m === 'POST') return 'finance_write';
  if (/^\/api\/withdrawals\/\d+\/(approve|reject|paid)$/.test(p) && m === 'POST') return 'finance_write';
  return 'deny';
}

function canAccess(role, method, path) {
  if (!VALID_ROLES.includes(role)) return false;
  if (role === 'super_admin') return true;
  const permission = permissionFor(method, path);
  if (permission === 'public') return true;
  if (role === 'auditor') return ['dashboard','finance_read','wallet_read','operations_read','chain_read'].includes(permission) && String(method).toUpperCase() === 'GET';
  if (role === 'finance') return ['dashboard','finance_read','wallet_read','finance_write'].includes(permission);
  if (role === 'operator') return ['dashboard','wallet_read','wallet_write','operations_read','chain_read','chain_ops'].includes(permission);
  return false;
}

module.exports = { VALID_ROLES, permissionFor, canAccess };
