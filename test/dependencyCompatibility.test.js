'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));

test('package manifest and lockfile use the same engine and dependency specifications', () => {
  assert.equal(lock.version, pkg.version);
  assert.equal(lock.packages[''].version, pkg.version);
  assert.equal(lock.packages[''].engines.node, pkg.engines.node);
  assert.deepEqual(lock.packages[''].dependencies, pkg.dependencies);
});

test('security-sensitive direct dependencies are on the approved refreshed versions', () => {
  assert.equal(lock.packages['node_modules/bcryptjs'].version, '3.0.3');
  assert.equal(lock.packages['node_modules/dotenv'].version, '18.0.10');
  assert.equal(lock.packages['node_modules/express'].version, '4.22.3');
  assert.equal(lock.packages['node_modules/jsonwebtoken'].version, '9.0.3');
  assert.equal(lock.packages['node_modules/mysql2'].version, '3.24.6');
  assert.equal(lock.packages['node_modules/socket.io'].version, '4.8.4');
});

test('bcryptjs 3 can hash and verify existing password format', () => {
  const bcrypt = require('bcryptjs');
  const hash = bcrypt.hashSync('dependency-upgrade-compatibility-check', 4);
  assert.equal(bcrypt.compareSync('dependency-upgrade-compatibility-check', hash), true);
  assert.equal(bcrypt.compareSync('incorrect-password', hash), false);
  const legacyV2Hash = hash.replace(/^\\$2[ab]\\$/, '$2a
});

test('dotenv 18 keeps the config parser contract used by the application', () => {
  const dotenv = require('dotenv');
  const parsed = dotenv.parse('BOT_TOKEN=sample-token\nJWT_SECRET="a-long-secret-value"');
  assert.equal(parsed.BOT_TOKEN, 'sample-token');
  assert.equal(parsed.JWT_SECRET, 'a-long-secret-value');
});

test('runtime policy excludes unsupported Node.js majors', () => {
  assert.equal(pkg.engines.node, '>=24 <27');
});


test('fresh installer selects NodeSource 26 and requires supported Node 24+', () => {
  const installer = fs.readFileSync(path.join(root, 'install.sh'), 'utf8');
  assert.match(installer, /MIN_NODE_MAJOR=24/);
  assert.match(installer, /nodesource\.com\/node_26\.x/);
});

test('CI covers both supported Node LTS lines and MariaDB LTS lines', () => {
  const workflow = fs.readFileSync(path.join(root, '.github/workflows/ci.yml'), 'utf8');
  assert.match(workflow, /node-version: \[24, 26\]/);
  assert.match(workflow, /mariadb-version: \['11\.4', '11\.8'\]/);
});
);
  assert.match(legacyV2Hash, /^\\$2a\\$/);
  assert.equal(bcrypt.compareSync('dependency-upgrade-compatibility-check', legacyV2Hash), true);
});

test('dotenv 18 keeps the config parser contract used by the application', () => {
  const dotenv = require('dotenv');
  const parsed = dotenv.parse('BOT_TOKEN=sample-token\nJWT_SECRET="a-long-secret-value"');
  assert.equal(parsed.BOT_TOKEN, 'sample-token');
  assert.equal(parsed.JWT_SECRET, 'a-long-secret-value');
});

test('runtime policy excludes unsupported Node.js majors', () => {
  assert.equal(pkg.engines.node, '>=24 <27');
});


test('fresh installer selects NodeSource 26 and requires supported Node 24+', () => {
  const installer = fs.readFileSync(path.join(root, 'install.sh'), 'utf8');
  assert.match(installer, /MIN_NODE_MAJOR=24/);
  assert.match(installer, /nodesource\.com\/node_26\.x/);
});

test('CI covers both supported Node LTS lines and MariaDB LTS lines', () => {
  const workflow = fs.readFileSync(path.join(root, '.github/workflows/ci.yml'), 'utf8');
  assert.match(workflow, /node-version: \[24, 26\]/);
  assert.match(workflow, /mariadb-version: \['11\.4', '11\.8'\]/);
});
