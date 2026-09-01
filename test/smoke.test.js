'use strict';

const { after, before, test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const port = 3100 + Number(process.env.TEST_WORKER_ID || 0);
const origin = `http://127.0.0.1:${port}`;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'activity-challenge-'));
let server;

before(async () => {
  server = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      PORT: String(port),
      DATA_DIR: dataDir,
      APP_ORIGIN: origin,
      SEED_ADMIN_EMAIL: 'admin@example.com',
      SEED_ADMIN_PASSWORD: 'ChangeMe123!',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Server did not start in time')), 10000);
    server.once('exit', code => reject(new Error(`Server exited before tests with code ${code}`)));
    server.stdout.on('data', chunk => {
      if (chunk.toString().includes('Activity Challenge running')) {
        clearTimeout(timeout);
        resolve();
      }
    });
    server.stderr.on('data', chunk => process.stderr.write(chunk));
  });
});

after(async () => {
  if (server && !server.killed) {
    server.kill();
    await new Promise(resolve => server.once('exit', resolve));
  }
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('serves the web app and supports seeded admin login', async () => {
  const home = await fetch(origin);
  assert.equal(home.status, 200);
  assert.match(await home.text(), /Active Together/);

  const anonymousMe = await fetch(`${origin}/api/me`);
  assert.equal(anonymousMe.status, 200);
  assert.deepEqual(await anonymousMe.json(), { user: null });

  const login = await fetch(`${origin}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'admin@example.com', password: 'ChangeMe123!' }),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie');
  assert.match(cookie, /session=/);

  const dashboard = await fetch(`${origin}/api/dashboard`, {
    headers: { cookie },
  });
  assert.equal(dashboard.status, 200);
  const dashboardBody = await dashboard.json();
  assert.equal(dashboardBody.user.email, 'admin@example.com');
  assert.equal(dashboardBody.user.role, 'global_admin');
  assert.ok(dashboardBody.challenges.length >= 1);
});
