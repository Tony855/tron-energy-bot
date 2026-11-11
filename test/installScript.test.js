const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const script = fs.readFileSync(new URL('../install.sh', `file://${__filename}`).pathname, 'utf8');

test('installer refuses to overwrite an existing environment file', () => {
  assert.match(script, /\[\[ ! -e "\$ENV_FILE" \]\] \|\| die/);
});

test('installer creates a TCP MySQL account matching DB_HOST=127.0.0.1', () => {
  assert.match(script, /DB_HOST=127\.0\.0\.1/);
  assert.match(script, /'\$\{DB_USER\}'@'127\.0\.0\.1'/);
  assert.match(script, /--protocol=tcp -h 127\.0\.0\.1/);
});

test('installer defaults to event-only mode and keeps automatic credit disabled', () => {
  assert.match(script, /TRON_EVENT_ONLY=true/);
  assert.match(script, /AUTO_CREDIT_CONFIRMED=false/);
});

test('installer validates domain input and configures reverse-proxy WebSocket headers', () => {
  assert.match(script, /域名格式不正确/);
  assert.match(script, /proxy_set_header Upgrade/);
  assert.match(script, /proxy_read_timeout 75s/);
});

test('installer checks production dependencies, tests, database credentials and health endpoint', () => {
  assert.match(script, /npm --prefix "\$APP_DIR" run check/);
  assert.match(script, /npm --prefix "\$APP_DIR" test/);
  assert.match(script, /应用数据库账号连接失败/);
  assert.match(script, /健康检查/);
});


test('installer generates admin and database passwords and prints/saves them after success', () => {
  assert.match(script, /ADMIN_PASSWORD="\$\(openssl rand -hex 16\)"/);
  assert.match(script, /DB_PASSWORD="\$\(openssl rand -hex 24\)"/);
  assert.match(script, /后台管理员密码：%s/);
  assert.match(script, /MySQL 数据库密码：%s/);
  assert.match(script, /CREDENTIALS_FILE="\/root\/tron-energy-bot-credentials\.txt"/);
  assert.match(script, /chmod 0600 "\$CREDENTIALS_FILE"/);
});

test('installer explicitly selects the application database for every migration', () => {
  assert.match(script, /mysql --protocol=socket "\$DB_NAME" < "\$migration"/);
  assert.doesNotMatch(script, /mysql --protocol=socket < "\$migration"/);
});

test('installer fails closed when the V4 durable queue migration fails', () => {
  assert.match(script, /migrate_v4_durable_queue\.sql/);
  assert.match(script, /V4 durable queue migration failed; refusing to start an incomplete installation/);
  assert.match(script, /mysql --protocol=socket "\$DB_NAME" < "\$migration" \|\| die/);
});

test('fresh schema has valid users column and constraint ordering', () => {
  const schema = fs.readFileSync(new URL('../sql/schema.sql', `file://${__filename}`).pathname, 'utf8');
  const users = schema.match(/CREATE TABLE IF NOT EXISTS users \(([\s\S]*?)\) ENGINE=InnoDB;/)?.[1] || '';
  assert.match(users, /language VARCHAR\(8\) NULL/);
  assert.match(users, /tron_wallet_address VARCHAR\(42\) DEFAULT NULL/);
  assert.ok(users.indexOf('tron_wallet_address') < users.indexOf('CONSTRAINT fk_users_referrer'));
  assert.doesNotMatch(users, /,\s*$/);
});

test('installer verifies all V4 tables and required energy order enum values before service setup', () => {
  assert.match(script, /V4_TABLE_COUNT=.*information_schema\.tables/);
  assert.match(script, /\[\[ "\$V4_TABLE_COUNT" == "4" \]\]/);
  assert.match(script, /V4_STATUS_TYPE=.*information_schema\.columns/);
  assert.match(script, /submission_unknown/);
  assert.match(script, /energy_orders\.status is missing required V4 states/);
});
