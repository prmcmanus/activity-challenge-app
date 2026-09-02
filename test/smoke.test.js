'use strict';

const { after, before, test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const basePort = 3100 + Number(process.env.TEST_WORKER_ID || 0) * 100;
let nextPort = basePort;

async function spawnServer(extraEnv = {}) {
  const p = nextPort++;
  const o = `http://127.0.0.1:${p}`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'activity-challenge-'));
  const proc = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      PORT: String(p),
      DATA_DIR: dir,
      APP_ORIGIN: o,
      SEED_ADMIN_EMAIL: 'admin@example.com',
      SEED_ADMIN_PASSWORD: 'ChangeMe123!',
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Server did not start in time')), 10000);
    proc.once('exit', code => reject(new Error(`Server exited before tests with code ${code}`)));
    proc.stdout.on('data', chunk => {
      if (chunk.toString().includes('Activity Challenge running')) {
        clearTimeout(timeout);
        resolve();
      }
    });
    proc.stderr.on('data', chunk => process.stderr.write(chunk));
  });

  return {
    origin: o,
    async stop() {
      if (!proc.killed) {
        proc.kill();
        await new Promise(resolve => proc.once('exit', resolve));
      }
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

const port = basePort;
const origin = `http://127.0.0.1:${port}`;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'activity-challenge-'));
let server;

before(async () => {
  nextPort = port + 1;
  server = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      PORT: String(port),
      DATA_DIR: dataDir,
      APP_ORIGIN: origin,
      SEED_ADMIN_EMAIL: 'admin@example.com',
      SEED_ADMIN_PASSWORD: 'ChangeMe123!',
      // High enough that this suite's normal traffic (many register() calls from one IP) never
      // trips it; the rate-limit behaviour itself is exercised against dedicated servers below
      // with tiny explicit limits instead.
      AUTH_RATE_LIMIT_MAX: '200',
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

let uid = 0;
async function register(name) {
  uid += 1;
  const email = `${name.toLowerCase().replace(/\s+/g, '.')}.${uid}@example.com`;
  const r = await fetch(`${origin}/api/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, email, password: 'SuperSecret123!' }),
  });
  const j = await r.json();
  assert.equal(r.status, 201, `register ${name} failed: ${JSON.stringify(j)}`);
  const cookie = r.headers.get('set-cookie').split(';')[0];
  return { email, cookie, token: j.sessionToken, user: j.user };
}

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
  const loginBody = await login.json();
  assert.match(loginBody.sessionToken, /^[a-f0-9]+$/);
  assert.equal(loginBody.user.email, 'admin@example.com');
  assert.equal(loginBody.user.role, 'global_admin');

  const dashboard = await fetch(`${origin}/api/dashboard`, { headers: { cookie } });
  assert.equal(dashboard.status, 200);
  const dashboardBody = await dashboard.json();
  assert.equal(dashboardBody.user.email, 'admin@example.com');
  assert.ok(dashboardBody.challenges.length >= 1, 'seeded admin should already own the demo challenge');
});

test('rejects duplicate registration and short passwords', async () => {
  const a = await register('Dup User');
  const dupe = await fetch(`${origin}/api/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Dup User', email: a.email, password: 'SuperSecret123!' }),
  });
  assert.equal(dupe.status, 409);

  const shortPw = await fetch(`${origin}/api/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Short Pw', email: 'shortpw@example.com', password: 'short' }),
  });
  assert.equal(shortPw.status, 400);
});

test('a self-registered user can create a challenge and a team, and log activity', async () => {
  const alice = await register('Alice Creator');

  const challenge = await fetch(`${origin}/api/challenges`, {
    method: 'POST',
    headers: { cookie: alice.cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: "Alice's Challenge", start_date: '2026-01-01', end_date: '2026-01-31' }),
  });
  assert.equal(challenge.status, 201);
  const { id: challengeId, invite_code: challengeCode } = await challenge.json();
  assert.match(challengeCode, /^[A-Z0-9]{8}$/);

  const team = await fetch(`${origin}/api/teams`, {
    method: 'POST',
    headers: { cookie: alice.cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ challenge_id: challengeId, name: 'Team Rocket' }),
  });
  assert.equal(team.status, 201);
  const { id: teamId, invite_code: teamCode } = await team.json();

  const activity = await fetch(`${origin}/api/activities`, {
    method: 'POST',
    headers: { cookie: alice.cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ team_id: teamId, challenge_id: challengeId, activity_type: 'Running', minutes: 30, activity_date: '2026-01-05' }),
  });
  assert.equal(activity.status, 201);

  const dashboard = await fetch(`${origin}/api/dashboard`, { headers: { cookie: alice.cookie } });
  const dashboardBody = await dashboard.json();
  const mine = dashboardBody.challenges.find(c => c.id === challengeId);
  assert.ok(mine, 'creator should see their own challenge');
  assert.equal(mine.role, 'owner');
  assert.equal(mine.myMinutes, 30);
  assert.equal(mine.teams[0].id, teamId);
  assert.equal(mine.teams[0].invite_code, teamCode);

  // mismatched team/challenge pairing must be rejected
  const otherChallenge = await fetch(`${origin}/api/challenges`, {
    method: 'POST',
    headers: { cookie: alice.cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Other Challenge', start_date: '2026-02-01', end_date: '2026-02-28' }),
  });
  const { id: otherChallengeId } = await otherChallenge.json();
  const mismatched = await fetch(`${origin}/api/activities`, {
    method: 'POST',
    headers: { cookie: alice.cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ team_id: teamId, challenge_id: otherChallengeId, activity_type: 'Cycling', minutes: 10, activity_date: '2026-02-05' }),
  });
  assert.equal(mismatched.status, 400);
});

test('challenges and teams are invisible until joined, then joinable by invite code', async () => {
  const alice = await register('Alice Owner');
  const bob = await register('Bob Outsider');

  const challengeRes = await fetch(`${origin}/api/challenges`, {
    method: 'POST',
    headers: { cookie: alice.cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Private Challenge', start_date: '2026-03-01', end_date: '2026-03-31' }),
  });
  const { id: challengeId, invite_code: challengeCode } = await challengeRes.json();
  const teamRes = await fetch(`${origin}/api/teams`, {
    method: 'POST',
    headers: { cookie: alice.cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ challenge_id: challengeId, name: 'Team Blue' }),
  });
  const { id: teamId, invite_code: teamCode } = await teamRes.json();

  // Bob cannot see Alice's challenge or dashboard entry for it yet.
  const bobDashboard = await (await fetch(`${origin}/api/dashboard`, { headers: { cookie: bob.cookie } })).json();
  assert.equal(bobDashboard.challenges.find(c => c.id === challengeId), undefined);

  const forbidden = await fetch(`${origin}/api/challenges/${challengeId}`, { headers: { cookie: bob.cookie } });
  assert.equal(forbidden.status, 403);

  // Bob joins via the challenge-level invite code: he can now see the challenge and its team list,
  // but is not yet a member of the team, and the team's own invite code is hidden from him.
  const join = await fetch(`${origin}/api/join`, {
    method: 'POST',
    headers: { cookie: bob.cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: challengeCode }),
  });
  assert.equal(join.status, 200);
  assert.equal((await join.json()).type, 'challenge');

  const bobView = await (await fetch(`${origin}/api/challenges/${challengeId}`, { headers: { cookie: bob.cookie } })).json();
  assert.equal(bobView.role, 'member');
  assert.equal(bobView.teams.length, 1);
  assert.equal(bobView.teams[0].mine, false);
  assert.equal(bobView.teams[0].invite_code, undefined);

  // Bob self-joins the team (no code needed once inside the challenge).
  const teamJoin = await fetch(`${origin}/api/teams/${teamId}/join`, { method: 'POST', headers: { cookie: bob.cookie } });
  assert.equal(teamJoin.status, 200);

  const bobView2 = await (await fetch(`${origin}/api/challenges/${challengeId}`, { headers: { cookie: bob.cookie } })).json();
  assert.equal(bobView2.teams[0].mine, true);

  // A third user joins directly via the team's own invite code, which grants both team and challenge membership.
  const carol = await register('Carol Direct');
  const directJoin = await fetch(`${origin}/api/join`, {
    method: 'POST',
    headers: { cookie: carol.cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: teamCode }),
  });
  assert.equal(directJoin.status, 200);
  assert.equal((await directJoin.json()).type, 'team');
  const carolDashboard = await (await fetch(`${origin}/api/dashboard`, { headers: { cookie: carol.cookie } })).json();
  const carolChallenge = carolDashboard.challenges.find(c => c.id === challengeId);
  assert.ok(carolChallenge, 'joining via a team code should also grant challenge membership');
  assert.equal(carolChallenge.teams[0].id, teamId);

  const badCode = await fetch(`${origin}/api/join`, {
    method: 'POST',
    headers: { cookie: bob.cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: 'NOTREAL1' }),
  });
  assert.equal(badCode.status, 400);
});

test('per-challenge team and individual leaderboards only aggregate that challenge', async () => {
  const alice = await register('Alice Board');
  const bob = await register('Bob Board');

  const challengeRes = await fetch(`${origin}/api/challenges`, {
    method: 'POST',
    headers: { cookie: alice.cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Board Challenge', start_date: '2026-04-01', end_date: '2026-04-30' }),
  });
  const { id: challengeId, invite_code: challengeCode } = await challengeRes.json();
  const teamARes = await fetch(`${origin}/api/teams`, {
    method: 'POST',
    headers: { cookie: alice.cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ challenge_id: challengeId, name: 'Team A' }),
  });
  const { id: teamAId } = await teamARes.json();

  await fetch(`${origin}/api/join`, { method: 'POST', headers: { cookie: bob.cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ code: challengeCode }) });
  const teamBRes = await fetch(`${origin}/api/teams`, {
    method: 'POST',
    headers: { cookie: bob.cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ challenge_id: challengeId, name: 'Team B' }),
  });
  const { id: teamBId } = await teamBRes.json();

  await fetch(`${origin}/api/activities`, { method: 'POST', headers: { cookie: alice.cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ team_id: teamAId, challenge_id: challengeId, activity_type: 'Walking', minutes: 50, activity_date: '2026-04-02' }) });
  await fetch(`${origin}/api/activities`, { method: 'POST', headers: { cookie: bob.cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ team_id: teamBId, challenge_id: challengeId, activity_type: 'Cycling', minutes: 20, activity_date: '2026-04-03' }) });

  const board = await (await fetch(`${origin}/api/challenges/${challengeId}/leaderboard`, { headers: { cookie: alice.cookie } })).json();
  assert.equal(board.teams.length, 2);
  assert.equal(board.teams[0].name, 'Team A');
  assert.equal(board.teams[0].minutes, 50);
  assert.equal(board.teams[1].minutes, 20);
  assert.equal(board.users.length, 2);
  assert.equal(board.users[0].name, 'Alice Board');
  assert.equal(board.users[0].minutes, 50);
});

test('supports companion app bearer auth and idempotent health imports', async () => {
  const dana = await register('Dana Mobile');
  const challengeRes = await fetch(`${origin}/api/challenges`, {
    method: 'POST',
    headers: { cookie: dana.cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Mobile Challenge', start_date: '2026-05-01', end_date: '2026-05-31' }),
  });
  const { id: challengeId } = await challengeRes.json();
  const teamRes = await fetch(`${origin}/api/teams`, {
    method: 'POST',
    headers: { cookie: dana.cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ challenge_id: challengeId, name: 'Mobile Team' }),
  });
  const { id: teamId } = await teamRes.json();

  const auth = { authorization: `Bearer ${dana.token}` };
  const bootstrap = await fetch(`${origin}/api/mobile/bootstrap`, { headers: auth });
  assert.equal(bootstrap.status, 200);
  const bootstrapBody = await bootstrap.json();
  assert.equal(bootstrapBody.user.email, dana.email);
  const bootstrapChallenge = bootstrapBody.challenges.find(c => c.id === challengeId);
  assert.equal(bootstrapChallenge.teams[0].id, teamId);
  assert.equal(bootstrapBody.health.uploadEndpoint, '/api/health/import');

  const importBody = {
    source: 'health_connect',
    records: [{
      team_id: teamId,
      challenge_id: challengeId,
      activity_type: 'Walking',
      minutes: 42,
      activity_date: '2026-05-02',
      source_ref: 'health-connect-test-record',
    }],
  };

  const firstImport = await fetch(`${origin}/api/health/import`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify(importBody),
  });
  assert.equal(firstImport.status, 200);
  assert.deepEqual(await firstImport.json(), { added: 1, skipped: 0 });

  const duplicateImport = await fetch(`${origin}/api/health/import`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify(importBody),
  });
  assert.equal(duplicateImport.status, 200);
  assert.deepEqual(await duplicateImport.json(), { added: 0, skipped: 1 });
});

test('GET /api/config reports reCAPTCHA as disabled when no keys are configured', async () => {
  const cfg = await (await fetch(`${origin}/api/config`)).json();
  assert.equal(cfg.recaptchaSiteKey, null);
});

test('the mobile-only login endpoint works without a recaptcha token and sets no cookie', async () => {
  const eve = await register('Eve Mobile');
  const login = await fetch(`${origin}/api/mobile/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: eve.email, password: 'SuperSecret123!' }),
  });
  assert.equal(login.status, 200);
  const body = await login.json();
  assert.match(body.sessionToken, /^[a-f0-9]+$/);
  assert.equal(body.user.email, eve.email);
  assert.equal(login.headers.get('set-cookie'), null);
});

test('registration and login are rate limited per IP', async () => {
  const srv = await spawnServer({ AUTH_RATE_LIMIT_MAX: '3', AUTH_RATE_LIMIT_WINDOW_MS: '60000' });
  try {
    for (let i = 0; i < 3; i++) {
      const r = await fetch(`${srv.origin}/api/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: `Bucket ${i}`, email: `bucket${i}@example.com`, password: 'SuperSecret123!' }),
      });
      assert.equal(r.status, 201, `attempt ${i} should still be within the limit`);
    }
    const blocked = await fetch(`${srv.origin}/api/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Bucket 4', email: 'bucket4@example.com', password: 'SuperSecret123!' }),
    });
    assert.equal(blocked.status, 429);

    // Login has its own independent bucket, so it isn't affected by register's being exhausted.
    const login = await fetch(`${srv.origin}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'admin@example.com', password: 'ChangeMe123!' }),
    });
    assert.equal(login.status, 200);
  } finally {
    await srv.stop();
  }
});

test('reCAPTCHA is enforced once configured, rejecting register/login with no token but exempting mobile login', async () => {
  const srv = await spawnServer({ RECAPTCHA_SITE_KEY: 'test-site-key', RECAPTCHA_SECRET_KEY: 'test-secret-key' });
  try {
    const cfg = await (await fetch(`${srv.origin}/api/config`)).json();
    assert.equal(cfg.recaptchaSiteKey, 'test-site-key');

    const noTokenRegister = await fetch(`${srv.origin}/api/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'No Token', email: 'notoken@example.com', password: 'SuperSecret123!' }),
    });
    assert.equal(noTokenRegister.status, 400);
    assert.match((await noTokenRegister.json()).error, /captcha/i);

    const noTokenLogin = await fetch(`${srv.origin}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'admin@example.com', password: 'ChangeMe123!' }),
    });
    assert.equal(noTokenLogin.status, 400);
    assert.match((await noTokenLogin.json()).error, /captcha/i);

    const mobileLogin = await fetch(`${srv.origin}/api/mobile/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'admin@example.com', password: 'ChangeMe123!' }),
    });
    assert.equal(mobileLogin.status, 200);
  } finally {
    await srv.stop();
  }
});

test('the general per-IP API rate limit applies across endpoints', async () => {
  const srv = await spawnServer({ API_RATE_LIMIT_MAX: '5', API_RATE_LIMIT_WINDOW_MS: '60000' });
  try {
    for (let i = 0; i < 5; i++) {
      const r = await fetch(`${srv.origin}/api/me`);
      assert.equal(r.status, 200, `request ${i} should still be within the limit`);
    }
    const blocked = await fetch(`${srv.origin}/api/me`);
    assert.equal(blocked.status, 429);
  } finally {
    await srv.stop();
  }
});
