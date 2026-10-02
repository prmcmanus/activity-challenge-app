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
      API_RATE_LIMIT_MAX: '5000',
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

test('a team admin can rename their team; a plain member cannot rename or delete it', async () => {
  const alice = await register('Alice TeamAdmin');
  const challengeRes = await fetch(`${origin}/api/challenges`, {
    method: 'POST',
    headers: { cookie: alice.cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Rename Challenge', start_date: '2026-06-01', end_date: '2026-06-30' }),
  });
  const { id: challengeId, invite_code: challengeCode } = await challengeRes.json();
  const teamRes = await fetch(`${origin}/api/teams`, {
    method: 'POST',
    headers: { cookie: alice.cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ challenge_id: challengeId, name: 'Original Name' }),
  });
  const { id: teamId } = await teamRes.json();

  const bob = await register('Bob PlainMember');
  await fetch(`${origin}/api/join`, { method: 'POST', headers: { cookie: bob.cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ code: challengeCode }) });
  await fetch(`${origin}/api/teams/${teamId}/join`, { method: 'POST', headers: { cookie: bob.cookie } });

  const forbiddenRename = await fetch(`${origin}/api/teams/${teamId}`, {
    method: 'PATCH',
    headers: { cookie: bob.cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Hijacked Name' }),
  });
  assert.equal(forbiddenRename.status, 403);
  const forbiddenDelete = await fetch(`${origin}/api/teams/${teamId}`, { method: 'DELETE', headers: { cookie: bob.cookie } });
  assert.equal(forbiddenDelete.status, 403);

  const rename = await fetch(`${origin}/api/teams/${teamId}`, {
    method: 'PATCH',
    headers: { cookie: alice.cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Renamed Team' }),
  });
  assert.equal(rename.status, 200);
  const view = await (await fetch(`${origin}/api/challenges/${challengeId}`, { headers: { cookie: alice.cookie } })).json();
  assert.equal(view.teams[0].name, 'Renamed Team');
  assert.equal(view.teams[0].canManage, true);
  const bobView = await (await fetch(`${origin}/api/challenges/${challengeId}`, { headers: { cookie: bob.cookie } })).json();
  assert.equal(bobView.teams[0].canManage, false);
});

test('a team admin can add an existing user by email and remove members; a plain member cannot', async () => {
  const alice = await register('Alice ManagerA');
  const dave = await register('Dave AddedByEmail');
  const bob = await register('Bob PlainMemberB');

  const challengeRes = await fetch(`${origin}/api/challenges`, {
    method: 'POST',
    headers: { cookie: alice.cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Roster Challenge', start_date: '2026-08-01', end_date: '2026-08-31' }),
  });
  const { id: challengeId, invite_code: challengeCode } = await challengeRes.json();
  const teamRes = await fetch(`${origin}/api/teams`, {
    method: 'POST',
    headers: { cookie: alice.cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ challenge_id: challengeId, name: 'Roster Team' }),
  });
  const { id: teamId } = await teamRes.json();
  await fetch(`${origin}/api/join`, { method: 'POST', headers: { cookie: bob.cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ code: challengeCode }) });
  await fetch(`${origin}/api/teams/${teamId}/join`, { method: 'POST', headers: { cookie: bob.cookie } });

  // Dave has no account with this made-up email yet — adding him should fail clearly.
  const noAccount = await fetch(`${origin}/api/teams/${teamId}/members`, {
    method: 'POST',
    headers: { cookie: alice.cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'nobody-registered@example.com' }),
  });
  assert.equal(noAccount.status, 404);

  // A plain member (Bob) cannot add people either, even though he's in the team.
  const forbiddenAdd = await fetch(`${origin}/api/teams/${teamId}/members`, {
    method: 'POST',
    headers: { cookie: bob.cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: dave.email }),
  });
  assert.equal(forbiddenAdd.status, 403);

  // Alice (team admin) adds Dave directly by his registered email — no invite acceptance needed.
  const add = await fetch(`${origin}/api/teams/${teamId}/members`, {
    method: 'POST',
    headers: { cookie: alice.cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: dave.email }),
  });
  assert.equal(add.status, 201);
  assert.equal((await add.json()).user.email, dave.email);

  // Dave can now see the challenge and is already in the team, with no action of his own.
  const daveDashboard = await (await fetch(`${origin}/api/dashboard`, { headers: { cookie: dave.cookie } })).json();
  const daveChallenge = daveDashboard.challenges.find(c => c.id === challengeId);
  assert.ok(daveChallenge, 'adding by email should also grant challenge membership');
  assert.equal(daveChallenge.teams[0].id, teamId);

  // The roster is visible to any team member (Bob), but only managers may act on it.
  const rosterAsBob = await (await fetch(`${origin}/api/teams/${teamId}/members`, { headers: { cookie: bob.cookie } })).json();
  assert.equal(rosterAsBob.canManage, false);
  assert.equal(rosterAsBob.members.length, 3);

  const rosterAsAlice = await (await fetch(`${origin}/api/teams/${teamId}/members`, { headers: { cookie: alice.cookie } })).json();
  assert.equal(rosterAsAlice.canManage, true);
  const daveMember = rosterAsAlice.members.find(m => m.email === dave.email);

  // Bob cannot remove Dave.
  const forbiddenRemove = await fetch(`${origin}/api/teams/${teamId}/members/${daveMember.id}`, { method: 'DELETE', headers: { cookie: bob.cookie } });
  assert.equal(forbiddenRemove.status, 403);

  // Alice removes Dave from the team; he keeps his challenge membership.
  const remove = await fetch(`${origin}/api/teams/${teamId}/members/${daveMember.id}`, { method: 'DELETE', headers: { cookie: alice.cookie } });
  assert.equal(remove.status, 200);
  const rosterAfter = await (await fetch(`${origin}/api/teams/${teamId}/members`, { headers: { cookie: alice.cookie } })).json();
  assert.equal(rosterAfter.members.length, 2);
  const daveChallengeAfter = (await (await fetch(`${origin}/api/dashboard`, { headers: { cookie: dave.cookie } })).json()).challenges.find(c => c.id === challengeId);
  assert.ok(daveChallengeAfter, 'removing from the team should not remove challenge membership');
  assert.equal(daveChallengeAfter.teams.length, 0);
});

test('someone outside a team cannot view its member roster', async () => {
  const alice = await register('Alice RosterPrivate');
  const outsider = await register('Outsider RosterPrivate');
  const challengeRes = await fetch(`${origin}/api/challenges`, {
    method: 'POST',
    headers: { cookie: alice.cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Private Roster Challenge', start_date: '2026-08-01', end_date: '2026-08-31' }),
  });
  const { id: challengeId } = await challengeRes.json();
  const teamRes = await fetch(`${origin}/api/teams`, {
    method: 'POST',
    headers: { cookie: alice.cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ challenge_id: challengeId, name: 'Secret Team' }),
  });
  const { id: teamId } = await teamRes.json();
  const forbidden = await fetch(`${origin}/api/teams/${teamId}/members`, { headers: { cookie: outsider.cookie } });
  assert.equal(forbidden.status, 403);
});

test('the challenge owner can delete a team created by someone else, and it takes its activity with it', async () => {
  const alice = await register('Alice ChallengeOwner');
  const bob = await register('Bob TeamCreator');
  const challengeRes = await fetch(`${origin}/api/challenges`, {
    method: 'POST',
    headers: { cookie: alice.cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Delete Challenge', start_date: '2026-07-01', end_date: '2026-07-31' }),
  });
  const { id: challengeId, invite_code: challengeCode } = await challengeRes.json();
  await fetch(`${origin}/api/join`, { method: 'POST', headers: { cookie: bob.cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ code: challengeCode }) });
  const teamRes = await fetch(`${origin}/api/teams`, {
    method: 'POST',
    headers: { cookie: bob.cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ challenge_id: challengeId, name: 'Bobs Team' }),
  });
  const { id: teamId, invite_code: teamCode } = await teamRes.json();
  await fetch(`${origin}/api/activities`, { method: 'POST', headers: { cookie: bob.cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ team_id: teamId, challenge_id: challengeId, activity_type: 'Running', minutes: 15, activity_date: '2026-07-05' }) });

  // Alice never joined this team (she's the challenge owner, not a member), but since she can
  // manage it she should still see its invite code, not just members can.
  const aliceView = await (await fetch(`${origin}/api/challenges/${challengeId}`, { headers: { cookie: alice.cookie } })).json();
  assert.equal(aliceView.teams[0].mine, false);
  assert.equal(aliceView.teams[0].canManage, true);
  assert.equal(aliceView.teams[0].invite_code, teamCode);

  const del = await fetch(`${origin}/api/teams/${teamId}`, { method: 'DELETE', headers: { cookie: alice.cookie } });
  assert.equal(del.status, 200);

  const view = await (await fetch(`${origin}/api/challenges/${challengeId}`, { headers: { cookie: alice.cookie } })).json();
  assert.equal(view.teams.length, 0);
  const board = await (await fetch(`${origin}/api/challenges/${challengeId}/leaderboard`, { headers: { cookie: alice.cookie } })).json();
  assert.equal(board.teams.length, 0);

  const missing = await fetch(`${origin}/api/teams/${teamId}`, { method: 'DELETE', headers: { cookie: alice.cookie } });
  assert.equal(missing.status, 404);
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

test('a user can edit their own name freely, but changing email or password requires the current password', async () => {
  const alice = await register('Alice Profile');

  const renameOnly = await fetch(`${origin}/api/me`, {
    method: 'PATCH',
    headers: { cookie: alice.cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Alice Renamed' }),
  });
  assert.equal(renameOnly.status, 200);
  assert.equal((await renameOnly.json()).user.name, 'Alice Renamed');

  const newEmail = `alice.new.${Date.now()}@example.com`;
  const noPassword = await fetch(`${origin}/api/me`, {
    method: 'PATCH',
    headers: { cookie: alice.cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: newEmail }),
  });
  assert.equal(noPassword.status, 400);

  const wrongPassword = await fetch(`${origin}/api/me`, {
    method: 'PATCH',
    headers: { cookie: alice.cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: newEmail, currentPassword: 'wrong-password' }),
  });
  assert.equal(wrongPassword.status, 400);

  const rightPassword = await fetch(`${origin}/api/me`, {
    method: 'PATCH',
    headers: { cookie: alice.cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: newEmail, currentPassword: 'SuperSecret123!' }),
  });
  assert.equal(rightPassword.status, 200);
  assert.equal((await rightPassword.json()).user.email, newEmail);

  // The now-changed email can sign in with the original password.
  const login = await fetch(`${origin}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: newEmail, password: 'SuperSecret123!' }),
  });
  assert.equal(login.status, 200);
});

test('changing your own password invalidates other sessions but not the one making the change', async () => {
  const alice = await register('Alice TwoSessions');
  const secondLogin = await fetch(`${origin}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: alice.email, password: 'SuperSecret123!' }),
  });
  const secondCookie = secondLogin.headers.get('set-cookie').split(';')[0];
  assert.equal((await fetch(`${origin}/api/me`, { headers: { cookie: secondCookie } })).status, 200);

  const change = await fetch(`${origin}/api/me`, {
    method: 'PATCH',
    headers: { cookie: alice.cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ newPassword: 'BrandNewPassword123', currentPassword: 'SuperSecret123!' }),
  });
  assert.equal(change.status, 200);

  // The session that made the change still works...
  const stillIn = await fetch(`${origin}/api/me`, { headers: { cookie: alice.cookie } });
  assert.equal(stillIn.status, 200);
  assert.notEqual((await stillIn.json()).user, null);

  // ...but the other, older session was signed out by the password change.
  const loggedOut = await fetch(`${origin}/api/me`, { headers: { cookie: secondCookie } });
  const loggedOutBody = await loggedOut.json();
  assert.equal(loggedOutBody.user, null);

  // The new password works; the old one no longer does.
  const newLogin = await fetch(`${origin}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: alice.email, password: 'BrandNewPassword123' }),
  });
  assert.equal(newLogin.status, 200);
  const oldLogin = await fetch(`${origin}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: alice.email, password: 'SuperSecret123!' }),
  });
  assert.equal(oldLogin.status, 401);
});

test('a global admin can edit any user, including a password reset that signs them out everywhere', async () => {
  const bob = await register('Bob AdminEdited');

  const adminLogin = await fetch(`${origin}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'admin@example.com', password: 'ChangeMe123!' }),
  });
  const adminCookie = adminLogin.headers.get('set-cookie');

  const bobUsers = await (await fetch(`${origin}/api/admin/users`, { headers: { cookie: adminCookie } })).json();
  const bobId = bobUsers.users.find(u => u.email === bob.email).id;

  const notAdmin = await fetch(`${origin}/api/admin/users/${bobId}`, {
    method: 'PATCH',
    headers: { cookie: bob.cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Should Not Work' }),
  });
  assert.equal(notAdmin.status, 403);

  const edit = await fetch(`${origin}/api/admin/users/${bobId}`, {
    method: 'PATCH',
    headers: { cookie: adminCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Bob Renamed By Admin', password: 'AdminSetPassword123' }),
  });
  assert.equal(edit.status, 200);

  // Bob's existing session is now dead - the admin reset his password.
  const bobsSession = await fetch(`${origin}/api/me`, { headers: { cookie: bob.cookie } });
  assert.equal((await bobsSession.json()).user, null);

  const bobLoginOld = await fetch(`${origin}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: bob.email, password: 'SuperSecret123!' }),
  });
  assert.equal(bobLoginOld.status, 401);
  const bobLoginNew = await fetch(`${origin}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: bob.email, password: 'AdminSetPassword123' }),
  });
  assert.equal(bobLoginNew.status, 200);
  assert.equal((await bobLoginNew.json()).user.name, 'Bob Renamed By Admin');

  const missing = await fetch(`${origin}/api/admin/users/999999`, {
    method: 'PATCH',
    headers: { cookie: adminCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Nobody' }),
  });
  assert.equal(missing.status, 404);
});

test('an activity can be edited or deleted only by the person who logged it', async () => {
  const alice = await register('Alice ActivityOwner');
  const bob = await register('Bob NotOwner');
  const challengeRes = await fetch(`${origin}/api/challenges`, {
    method: 'POST',
    headers: { cookie: alice.cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Activity Edit Challenge', start_date: '2026-09-01', end_date: '2026-09-30' }),
  });
  const { id: challengeId, invite_code: challengeCode } = await challengeRes.json();
  const teamRes = await fetch(`${origin}/api/teams`, {
    method: 'POST',
    headers: { cookie: alice.cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ challenge_id: challengeId, name: 'Activity Edit Team' }),
  });
  const { id: teamId } = await teamRes.json();
  await fetch(`${origin}/api/join`, { method: 'POST', headers: { cookie: bob.cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ code: challengeCode }) });
  await fetch(`${origin}/api/teams/${teamId}/join`, { method: 'POST', headers: { cookie: bob.cookie } });

  const logged = await fetch(`${origin}/api/activities`, {
    method: 'POST',
    headers: { cookie: alice.cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ team_id: teamId, challenge_id: challengeId, activity_type: 'Walking', minutes: 20, activity_date: '2026-09-05' }),
  });
  assert.equal(logged.status, 201);
  const dashboardAfterLog = await (await fetch(`${origin}/api/dashboard`, { headers: { cookie: alice.cookie } })).json();
  const activityId = dashboardAfterLog.mine.find(a => a.challenge_id === challengeId).id;

  // Bob cannot edit or delete Alice's activity.
  const forbiddenEdit = await fetch(`${origin}/api/activities/${activityId}`, {
    method: 'PATCH',
    headers: { cookie: bob.cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ minutes: 999 }),
  });
  assert.equal(forbiddenEdit.status, 403);
  const forbiddenDelete = await fetch(`${origin}/api/activities/${activityId}`, { method: 'DELETE', headers: { cookie: bob.cookie } });
  assert.equal(forbiddenDelete.status, 403);

  // Alice can edit it - fixing the minutes and activity type.
  const edit = await fetch(`${origin}/api/activities/${activityId}`, {
    method: 'PATCH',
    headers: { cookie: alice.cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ activity_type: 'Running', minutes: 35 }),
  });
  assert.equal(edit.status, 200);
  const board = await (await fetch(`${origin}/api/challenges/${challengeId}/leaderboard`, { headers: { cookie: alice.cookie } })).json();
  assert.equal(board.teams[0].minutes, 35);

  // Invalid edits are rejected.
  const badEdit = await fetch(`${origin}/api/activities/${activityId}`, {
    method: 'PATCH',
    headers: { cookie: alice.cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ minutes: 0 }),
  });
  assert.equal(badEdit.status, 400);

  // Alice deletes it; it disappears from the leaderboard entirely.
  const del = await fetch(`${origin}/api/activities/${activityId}`, { method: 'DELETE', headers: { cookie: alice.cookie } });
  assert.equal(del.status, 200);
  const boardAfter = await (await fetch(`${origin}/api/challenges/${challengeId}/leaderboard`, { headers: { cookie: alice.cookie } })).json();
  assert.equal(boardAfter.teams[0].minutes, 0);

  const missing = await fetch(`${origin}/api/activities/${activityId}`, { method: 'DELETE', headers: { cookie: alice.cookie } });
  assert.equal(missing.status, 404);
});

test('activities accept an optional start/finish time, validated as a matched, ordered pair', async () => {
  const alice = await register('Alice Times');
  const challengeRes = await fetch(`${origin}/api/challenges`, {
    method: 'POST',
    headers: { cookie: alice.cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Times Challenge', start_date: '2026-10-01', end_date: '2026-10-31' }),
  });
  const { id: challengeId } = await challengeRes.json();
  const teamRes = await fetch(`${origin}/api/teams`, {
    method: 'POST',
    headers: { cookie: alice.cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ challenge_id: challengeId, name: 'Times Team' }),
  });
  const { id: teamId } = await teamRes.json();
  const base = { team_id: teamId, challenge_id: challengeId, activity_type: 'Walking', minutes: 30, activity_date: '2026-10-05' };

  const onlyStart = await fetch(`${origin}/api/activities`, {
    method: 'POST', headers: { cookie: alice.cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...base, start_time: '07:00' }),
  });
  assert.equal(onlyStart.status, 400);

  const backwards = await fetch(`${origin}/api/activities`, {
    method: 'POST', headers: { cookie: alice.cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...base, start_time: '08:00', end_time: '07:30' }),
  });
  assert.equal(backwards.status, 400);

  const badFormat = await fetch(`${origin}/api/activities`, {
    method: 'POST', headers: { cookie: alice.cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...base, start_time: '7:00', end_time: '07:30' }),
  });
  assert.equal(badFormat.status, 400);

  const good = await fetch(`${origin}/api/activities`, {
    method: 'POST', headers: { cookie: alice.cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...base, start_time: '07:00', end_time: '07:30' }),
  });
  assert.equal(good.status, 201);
  const dashboard = await (await fetch(`${origin}/api/dashboard`, { headers: { cookie: alice.cookie } })).json();
  const logged = dashboard.mine.find(a => a.challenge_id === challengeId);
  assert.equal(logged.start_time, '07:00');
  assert.equal(logged.end_time, '07:30');

  // Times can be edited, and cleared by sending both back empty.
  const clear = await fetch(`${origin}/api/activities/${logged.id}`, {
    method: 'PATCH', headers: { cookie: alice.cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ start_time: '', end_time: '' }),
  });
  assert.equal(clear.status, 200);
  const afterClear = (await (await fetch(`${origin}/api/dashboard`, { headers: { cookie: alice.cookie } })).json()).mine.find(a => a.id === logged.id);
  assert.equal(afterClear.start_time, null);
  assert.equal(afterClear.end_time, null);
});

test('health import keeps a synced record even when its times are inconsistent, just without times', async () => {
  const dana = await register('Dana ImportTimes');
  const challengeRes = await fetch(`${origin}/api/challenges`, {
    method: 'POST',
    headers: { cookie: dana.cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Import Times Challenge', start_date: '2026-10-01', end_date: '2026-10-31' }),
  });
  const { id: challengeId } = await challengeRes.json();
  const teamRes = await fetch(`${origin}/api/teams`, {
    method: 'POST',
    headers: { cookie: dana.cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ challenge_id: challengeId, name: 'Import Times Team' }),
  });
  const { id: teamId } = await teamRes.json();
  const auth = { authorization: `Bearer ${dana.token}` };

  const importRes = await fetch(`${origin}/api/health/import`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      source: 'health_connect',
      records: [{
        team_id: teamId, challenge_id: challengeId, activity_type: 'Running', minutes: 45,
        activity_date: '2026-10-10', source_ref: 'overnight-session',
        // A workout that crossed midnight: end < start as plain HH:MM, which fails the same
        // validation a manual entry would - but a sync must not lose real minutes over it.
        start_time: '23:30', end_time: '00:15',
      }],
    }),
  });
  assert.equal(importRes.status, 200);
  assert.deepEqual(await importRes.json(), { added: 1, skipped: 0 });

  const dashboard = await (await fetch(`${origin}/api/dashboard`, { headers: { cookie: dana.cookie } })).json();
  const imported = dashboard.mine.find(a => a.source_ref === 'overnight-session');
  assert.equal(imported.minutes, 45);
  assert.equal(imported.start_time, null);
  assert.equal(imported.end_time, null);
});

test('a challenge owner can edit its name and dates; a plain member cannot', async () => {
  const alice = await register('Alice ChallengeEditor');
  const bob = await register('Bob ChallengeMember');
  const challengeRes = await fetch(`${origin}/api/challenges`, {
    method: 'POST',
    headers: { cookie: alice.cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Original Challenge Name', start_date: '2026-11-01', end_date: '2026-11-30' }),
  });
  const { id: challengeId, invite_code: challengeCode } = await challengeRes.json();
  await fetch(`${origin}/api/join`, { method: 'POST', headers: { cookie: bob.cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ code: challengeCode }) });

  const bobView = await (await fetch(`${origin}/api/challenges/${challengeId}`, { headers: { cookie: bob.cookie } })).json();
  assert.equal(bobView.canManage, false);
  const aliceView = await (await fetch(`${origin}/api/challenges/${challengeId}`, { headers: { cookie: alice.cookie } })).json();
  assert.equal(aliceView.canManage, true);

  const forbidden = await fetch(`${origin}/api/challenges/${challengeId}`, {
    method: 'PATCH',
    headers: { cookie: bob.cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Hijacked' }),
  });
  assert.equal(forbidden.status, 403);

  const edit = await fetch(`${origin}/api/challenges/${challengeId}`, {
    method: 'PATCH',
    headers: { cookie: alice.cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Renamed Challenge', start_date: '2026-11-05', end_date: '2026-12-05' }),
  });
  assert.equal(edit.status, 200);
  const updated = await (await fetch(`${origin}/api/challenges/${challengeId}`, { headers: { cookie: alice.cookie } })).json();
  assert.equal(updated.name, 'Renamed Challenge');
  assert.equal(updated.start_date, '2026-11-05');
  assert.equal(updated.end_date, '2026-12-05');

  const missingDate = await fetch(`${origin}/api/challenges/${challengeId}`, {
    method: 'PATCH',
    headers: { cookie: alice.cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ start_date: '' }),
  });
  assert.equal(missingDate.status, 400);

  // A global admin can edit it too, even without being a member of this challenge.
  const adminLogin = await fetch(`${origin}/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'admin@example.com', password: 'ChangeMe123!' }),
  });
  const adminCookie = adminLogin.headers.get('set-cookie');
  const adminEdit = await fetch(`${origin}/api/challenges/${challengeId}`, {
    method: 'PATCH',
    headers: { cookie: adminCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Renamed By Admin' }),
  });
  assert.equal(adminEdit.status, 200);

  const missing = await fetch(`${origin}/api/challenges/999999`, {
    method: 'PATCH',
    headers: { cookie: alice.cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Nobody' }),
  });
  assert.equal(missing.status, 404);
});

test('a challenge can have an optional description, settable at creation and later edited or cleared', async () => {
  const alice = await register('Alice Description');

  const withoutDescription = await fetch(`${origin}/api/challenges`, {
    method: 'POST',
    headers: { cookie: alice.cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'No Description Challenge', start_date: '2026-12-01', end_date: '2026-12-31' }),
  });
  const { id: plainId } = await withoutDescription.json();
  const plainView = await (await fetch(`${origin}/api/challenges/${plainId}`, { headers: { cookie: alice.cookie } })).json();
  assert.equal(plainView.description, null);

  const withDescription = await fetch(`${origin}/api/challenges`, {
    method: 'POST',
    headers: { cookie: alice.cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Described Challenge', description: 'Walk 10,000 steps a day.', start_date: '2026-12-01', end_date: '2026-12-31' }),
  });
  const { id: describedId } = await withDescription.json();
  const describedView = await (await fetch(`${origin}/api/challenges/${describedId}`, { headers: { cookie: alice.cookie } })).json();
  assert.equal(describedView.description, 'Walk 10,000 steps a day.');

  // It also shows up on the dashboard, not just the single-challenge view.
  const dashboard = await (await fetch(`${origin}/api/dashboard`, { headers: { cookie: alice.cookie } })).json();
  assert.equal(dashboard.challenges.find(c => c.id === describedId).description, 'Walk 10,000 steps a day.');

  const edited = await fetch(`${origin}/api/challenges/${describedId}`, {
    method: 'PATCH',
    headers: { cookie: alice.cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ description: 'Updated: run instead of walk.' }),
  });
  assert.equal(edited.status, 200);
  const editedView = await (await fetch(`${origin}/api/challenges/${describedId}`, { headers: { cookie: alice.cookie } })).json();
  assert.equal(editedView.description, 'Updated: run instead of walk.');

  const cleared = await fetch(`${origin}/api/challenges/${describedId}`, {
    method: 'PATCH',
    headers: { cookie: alice.cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ description: '' }),
  });
  assert.equal(cleared.status, 200);
  const clearedView = await (await fetch(`${origin}/api/challenges/${describedId}`, { headers: { cookie: alice.cookie } })).json();
  assert.equal(clearedView.description, null);
});

// A minimal valid 1x1 transparent PNG, used wherever a real (tiny) uploaded image is needed.
const TINY_PNG_DATA_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

async function uploadTinyPng(cookie) {
  const r = await fetch(`${origin}/api/uploads`, {
    method: 'POST',
    headers: { cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ dataUrl: TINY_PNG_DATA_URL }),
  });
  const j = await r.json();
  assert.equal(r.status, 201, `upload failed: ${JSON.stringify(j)}`);
  return j.url;
}

test('image uploads: a real PNG is accepted and served back; junk and oversized payloads are rejected', async () => {
  const alice = await register('Alice Uploads');

  const url = await uploadTinyPng(alice.cookie);
  assert.match(url, /^\/uploads\/[a-f0-9]{32}\.png$/);
  const fetched = await fetch(`${origin}${url}`);
  assert.equal(fetched.status, 200);
  assert.equal(fetched.headers.get('content-type'), 'image/png');

  const notAnImage = await fetch(`${origin}/api/uploads`, {
    method: 'POST',
    headers: { cookie: alice.cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ dataUrl: `data:image/png;base64,${Buffer.from('not actually a png').toString('base64')}` }),
  });
  assert.equal(notAnImage.status, 400);

  const notADataUrl = await fetch(`${origin}/api/uploads`, {
    method: 'POST',
    headers: { cookie: alice.cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ dataUrl: 'https://example.com/not-a-data-url.png' }),
  });
  assert.equal(notADataUrl.status, 400);

  const tooLarge = 'A'.repeat(15 * 1024 * 1024); // ~15MB of base64 text, over the 10MB decoded cap
  const oversized = await fetch(`${origin}/api/uploads`, {
    method: 'POST',
    headers: { cookie: alice.cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ dataUrl: `data:image/png;base64,${tooLarge}` }),
  });
  assert.equal(oversized.status, 413);
});

test('challenge description HTML is sanitized on write: scripts and event handlers are stripped, safe formatting survives', async () => {
  const alice = await register('Alice Sanitize');
  const imageUrl = await uploadTinyPng(alice.cookie);
  const malicious = `<p>Hello <b>team</b></p><script>alert(1)</script><img src="${imageUrl}" onerror="alert(2)" alt="pic"><a href="javascript:alert(3)">bad link</a><a href="https://example.com">good link</a><div style="color:red">nope</div>`;

  const challengeRes = await fetch(`${origin}/api/challenges`, {
    method: 'POST',
    headers: { cookie: alice.cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Sanitize Challenge', description: malicious, start_date: '2027-01-01', end_date: '2027-01-31' }),
  });
  const { id: challengeId } = await challengeRes.json();
  const view = await (await fetch(`${origin}/api/challenges/${challengeId}`, { headers: { cookie: alice.cookie } })).json();

  assert.ok(!view.description.includes('<script'), 'script tag must be stripped');
  assert.ok(!view.description.includes('alert(1)') || !view.description.includes('<script'), 'script content must not be executable');
  assert.ok(!view.description.includes('onerror'), 'event handler attribute must be stripped');
  assert.ok(!view.description.includes('javascript:'), 'javascript: href must be stripped');
  assert.ok(!view.description.includes('style='), 'style attribute must be stripped entirely');
  assert.ok(view.description.includes('<b>team</b>'), 'safe formatting tag must survive');
  assert.ok(view.description.includes(`<img src="${imageUrl}" alt="pic">`), 'our own uploaded image src must survive');
  assert.ok(view.description.includes('href="https://example.com"'), 'a safe https link must survive');
});

test('a team can have a logo image set at creation and changed later, shown in challenge detail and the leaderboard', async () => {
  const alice = await register('Alice TeamLogo');
  const imageUrl = await uploadTinyPng(alice.cookie);
  const challengeRes = await fetch(`${origin}/api/challenges`, {
    method: 'POST',
    headers: { cookie: alice.cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Logo Challenge', start_date: '2027-02-01', end_date: '2027-02-28' }),
  });
  const { id: challengeId } = await challengeRes.json();

  const badImage = await fetch(`${origin}/api/teams`, {
    method: 'POST',
    headers: { cookie: alice.cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ challenge_id: challengeId, name: 'Bad Logo Team', image_url: 'https://evil.com/x.png' }),
  });
  assert.equal(badImage.status, 400);

  const teamRes = await fetch(`${origin}/api/teams`, {
    method: 'POST',
    headers: { cookie: alice.cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ challenge_id: challengeId, name: 'Logo Team', image_url: imageUrl }),
  });
  const { id: teamId } = await teamRes.json();
  const view = await (await fetch(`${origin}/api/challenges/${challengeId}`, { headers: { cookie: alice.cookie } })).json();
  assert.equal(view.teams[0].image_url, imageUrl);

  const board = await (await fetch(`${origin}/api/challenges/${challengeId}/leaderboard`, { headers: { cookie: alice.cookie } })).json();
  assert.equal(board.teams[0].image_url, imageUrl);

  const secondImage = await uploadTinyPng(alice.cookie);
  const rename = await fetch(`${origin}/api/teams/${teamId}`, {
    method: 'PATCH',
    headers: { cookie: alice.cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Logo Team', image_url: secondImage }),
  });
  assert.equal(rename.status, 200);
  const viewAfter = await (await fetch(`${origin}/api/challenges/${challengeId}`, { headers: { cookie: alice.cookie } })).json();
  assert.equal(viewAfter.teams[0].image_url, secondImage);
});

test('activities support an optional comment, editable like the other fields', async () => {
  const alice = await register('Alice Comments');
  const challengeRes = await fetch(`${origin}/api/challenges`, {
    method: 'POST',
    headers: { cookie: alice.cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Comment Challenge', start_date: '2027-03-01', end_date: '2027-03-31' }),
  });
  const { id: challengeId } = await challengeRes.json();
  const teamRes = await fetch(`${origin}/api/teams`, {
    method: 'POST',
    headers: { cookie: alice.cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ challenge_id: challengeId, name: 'Comment Team' }),
  });
  const { id: teamId } = await teamRes.json();

  await fetch(`${origin}/api/activities`, {
    method: 'POST',
    headers: { cookie: alice.cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ team_id: teamId, challenge_id: challengeId, activity_type: 'Walking', minutes: 20, activity_date: '2027-03-05', comment: 'felt great today!' }),
  });
  const dashboard = await (await fetch(`${origin}/api/dashboard`, { headers: { cookie: alice.cookie } })).json();
  const logged = dashboard.mine.find(a => a.challenge_id === challengeId);
  assert.equal(logged.comment, 'felt great today!');

  const edit = await fetch(`${origin}/api/activities/${logged.id}`, {
    method: 'PATCH',
    headers: { cookie: alice.cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ comment: '' }),
  });
  assert.equal(edit.status, 200);
  const afterClear = (await (await fetch(`${origin}/api/dashboard`, { headers: { cookie: alice.cookie } })).json()).mine.find(a => a.id === logged.id);
  assert.equal(afterClear.comment, null);
});

test('a user can set an avatar (only from an uploaded image), shown in the leaderboard', async () => {
  const alice = await register('Alice Avatar');
  const imageUrl = await uploadTinyPng(alice.cookie);

  const badAvatar = await fetch(`${origin}/api/me`, {
    method: 'PATCH',
    headers: { cookie: alice.cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ avatarUrl: 'https://evil.com/x.png' }),
  });
  assert.equal(badAvatar.status, 400);

  const setAvatar = await fetch(`${origin}/api/me`, {
    method: 'PATCH',
    headers: { cookie: alice.cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ avatarUrl: imageUrl }),
  });
  assert.equal(setAvatar.status, 200);
  assert.equal((await setAvatar.json()).user.avatar_url, imageUrl);

  const challengeRes = await fetch(`${origin}/api/challenges`, {
    method: 'POST',
    headers: { cookie: alice.cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Avatar Challenge', start_date: '2027-04-01', end_date: '2027-04-30' }),
  });
  const { id: challengeId } = await challengeRes.json();
  const board = await (await fetch(`${origin}/api/challenges/${challengeId}/leaderboard`, { headers: { cookie: alice.cookie } })).json();
  assert.equal(board.users.find(x => x.name === 'Alice Avatar').avatar_url, imageUrl);
});

test('challenge owners/global admins can add another owner to a challenge; a plain member cannot', async () => {
  const alice = await register('Alice AddOwner');
  const bob = await register('Bob NewOwner');
  const carol = await register('Carol PlainMember');
  const challengeRes = await fetch(`${origin}/api/challenges`, {
    method: 'POST',
    headers: { cookie: alice.cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Co-Owned Challenge', start_date: '2027-05-01', end_date: '2027-05-31' }),
  });
  const { id: challengeId, invite_code: challengeCode } = await challengeRes.json();
  await fetch(`${origin}/api/join`, { method: 'POST', headers: { cookie: bob.cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ code: challengeCode }) });
  await fetch(`${origin}/api/join`, { method: 'POST', headers: { cookie: carol.cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ code: challengeCode }) });

  const forbiddenList = await fetch(`${origin}/api/challenges/${challengeId}/members`, { headers: { cookie: carol.cookie } });
  assert.equal(forbiddenList.status, 403);
  const forbiddenAdd = await fetch(`${origin}/api/challenges/${challengeId}/owners`, {
    method: 'POST', headers: { cookie: carol.cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ email: bob.email }),
  });
  assert.equal(forbiddenAdd.status, 403);

  // Bob is already a member (joined via code) - adding him as owner promotes him in place.
  const addExisting = await fetch(`${origin}/api/challenges/${challengeId}/owners`, {
    method: 'POST', headers: { cookie: alice.cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ email: bob.email }),
  });
  assert.equal(addExisting.status, 201);
  const membersAfter = await (await fetch(`${origin}/api/challenges/${challengeId}/members`, { headers: { cookie: alice.cookie } })).json();
  assert.equal(membersAfter.members.find(m => m.email === bob.email).challenge_role, 'owner');

  // Bob, now an owner, can add a fresh account directly (not previously a member) as owner too.
  const dave = await register('Dave BrandNewOwner');
  const addNew = await fetch(`${origin}/api/challenges/${challengeId}/owners`, {
    method: 'POST', headers: { cookie: bob.cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ email: dave.email }),
  });
  assert.equal(addNew.status, 201);
  const daveDashboard = await (await fetch(`${origin}/api/dashboard`, { headers: { cookie: dave.cookie } })).json();
  const daveChallenge = daveDashboard.challenges.find(c => c.id === challengeId);
  assert.equal(daveChallenge.role, 'owner');

  const unknownEmail = await fetch(`${origin}/api/challenges/${challengeId}/owners`, {
    method: 'POST', headers: { cookie: alice.cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'nobody@example.com' }),
  });
  assert.equal(unknownEmail.status, 404);
});

test('leaderboard CSV export is restricted to the challenge owner/global admin and produces valid CSV', async () => {
  const alice = await register('Alice CsvOwner');
  const bob = await register('Bob CsvMember');
  const challengeRes = await fetch(`${origin}/api/challenges`, {
    method: 'POST',
    headers: { cookie: alice.cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'CSV Challenge', start_date: '2027-06-01', end_date: '2027-06-30' }),
  });
  const { id: challengeId, invite_code: challengeCode } = await challengeRes.json();
  await fetch(`${origin}/api/join`, { method: 'POST', headers: { cookie: bob.cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ code: challengeCode }) });
  const teamRes = await fetch(`${origin}/api/teams`, {
    method: 'POST',
    headers: { cookie: alice.cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ challenge_id: challengeId, name: 'CSV Team' }),
  });
  const { id: teamId } = await teamRes.json();
  await fetch(`${origin}/api/activities`, { method: 'POST', headers: { cookie: alice.cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ team_id: teamId, challenge_id: challengeId, activity_type: 'Walking', minutes: 25, activity_date: '2027-06-05' }) });

  const forbidden = await fetch(`${origin}/api/challenges/${challengeId}/leaderboard/export?type=teams`, { headers: { cookie: bob.cookie } });
  assert.equal(forbidden.status, 403);

  const teamsCsv = await fetch(`${origin}/api/challenges/${challengeId}/leaderboard/export?type=teams`, { headers: { cookie: alice.cookie } });
  assert.equal(teamsCsv.status, 200);
  assert.match(teamsCsv.headers.get('content-type'), /text\/csv/);
  assert.match(teamsCsv.headers.get('content-disposition'), /attachment/);
  const teamsBody = await teamsCsv.text();
  assert.match(teamsBody, /^Rank,Team,Minutes\r\n/);
  assert.match(teamsBody, /CSV Team,25/);

  const usersCsv = await fetch(`${origin}/api/challenges/${challengeId}/leaderboard/export?type=users`, { headers: { cookie: alice.cookie } });
  const usersBody = await usersCsv.text();
  assert.match(usersBody, /^Rank,Name,Email,Minutes\r\n/);
  assert.match(usersBody, new RegExp(`Alice CsvOwner,${alice.email},25`));

  const missing = await fetch(`${origin}/api/challenges/999999/leaderboard/export?type=teams`, { headers: { cookie: alice.cookie } });
  assert.equal(missing.status, 404);
});

// --- distance challenges ------------------------------------------------------------------

async function jsonFetch(url, cookie, method = 'GET', payload) {
  const r = await fetch(url, {
    method,
    headers: { cookie, ...(payload ? { 'Content-Type': 'application/json' } : {}) },
    body: payload ? JSON.stringify(payload) : undefined,
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

async function distanceChallenge(owner, extra = {}) {
  const c = await jsonFetch(`${origin}/api/challenges`, owner.cookie, 'POST', { name: 'Mileage Month', start_date: '2027-07-01', end_date: '2027-07-31', metric: 'distance', distance_unit: 'mi', ...extra });
  assert.equal(c.status, 201, JSON.stringify(c.body));
  const t = await jsonFetch(`${origin}/api/teams`, owner.cookie, 'POST', { challenge_id: c.body.id, name: 'Milers' });
  return { challengeId: c.body.id, inviteCode: c.body.invite_code, teamId: t.body.id };
}

test('a challenge can measure distance instead of minutes; minutes stays the default', async () => {
  const ann = await register('Ann Distance');
  const plain = await jsonFetch(`${origin}/api/challenges`, ann.cookie, 'POST', { name: 'Time Month', start_date: '2027-07-01', end_date: '2027-07-31' });
  const plainDetail = await jsonFetch(`${origin}/api/challenges/${plain.body.id}`, ann.cookie);
  assert.equal(plainDetail.body.metric, 'minutes');

  const { challengeId } = await distanceChallenge(ann);
  const detail = await jsonFetch(`${origin}/api/challenges/${challengeId}`, ann.cookie);
  assert.equal(detail.body.metric, 'distance');
  assert.equal(detail.body.distance_unit, 'mi');

  const bad = await jsonFetch(`${origin}/api/challenges`, ann.cookie, 'POST', { name: 'Bad', start_date: '2027-07-01', end_date: '2027-07-31', metric: 'steps' });
  assert.equal(bad.status, 400);
  const badUnit = await jsonFetch(`${origin}/api/challenges/${challengeId}`, ann.cookie, 'PATCH', { distance_unit: 'furlongs' });
  assert.equal(badUnit.status, 400);
});

test('in a distance challenge, distance is required, minutes optional, and leaderboards rank by distance', async () => {
  const ann = await register('Ann Runner');
  const ben = await register('Ben Walker');
  const { challengeId, inviteCode, teamId } = await distanceChallenge(ann);
  await jsonFetch(`${origin}/api/join`, ben.cookie, 'POST', { code: inviteCode });
  const second = await jsonFetch(`${origin}/api/teams`, ben.cookie, 'POST', { challenge_id: challengeId, name: 'Strollers' });

  const noDistance = await jsonFetch(`${origin}/api/activities`, ann.cookie, 'POST', { team_id: teamId, challenge_id: challengeId, activity_type: 'Running', minutes: 30, activity_date: '2027-07-02' });
  assert.equal(noDistance.status, 400);
  assert.match(noDistance.body.error, /distance/i);

  // Distance only, no minutes at all.
  const run = await jsonFetch(`${origin}/api/activities`, ann.cookie, 'POST', { team_id: teamId, challenge_id: challengeId, activity_type: 'Running', distance: 3.1, distance_unit: 'mi', activity_date: '2027-07-02' });
  assert.equal(run.status, 201, JSON.stringify(run.body));
  // Kilometres are converted, whatever the challenge's own unit.
  const km = await jsonFetch(`${origin}/api/activities`, ann.cookie, 'POST', { team_id: teamId, challenge_id: challengeId, activity_type: 'Running', distance: 5, distance_unit: 'km', minutes: 28, activity_date: '2027-07-03' });
  assert.equal(km.status, 201);
  // Lots of minutes but little distance must not win a distance challenge.
  await jsonFetch(`${origin}/api/activities`, ben.cookie, 'POST', { team_id: second.body.id, challenge_id: challengeId, activity_type: 'Walking', distance: 2, minutes: 300, activity_date: '2027-07-02' });

  const lb = await jsonFetch(`${origin}/api/challenges/${challengeId}/leaderboard`, ann.cookie);
  assert.equal(lb.body.metric, 'distance');
  assert.equal(lb.body.teams[0].name, 'Milers');
  assert.equal(lb.body.teams[0].distance, 6.21); // 3.1 mi + 5 km (3.107 mi)
  assert.equal(lb.body.teams[0].minutes, 28);
  assert.equal(lb.body.users[0].name, 'Ann Runner');
  assert.equal(lb.body.users[1].distance, 2);
  assert.equal(lb.body.users[0].email, undefined, 'the member leaderboard must not expose emails');

  const dash = await jsonFetch(`${origin}/api/dashboard`, ann.cookie);
  const mine = dash.body.challenges.find(c => c.id === challengeId);
  assert.equal(mine.myDistance, 6.21);
  const entry = dash.body.mine.find(a => a.challenge_id === challengeId && a.minutes === null);
  assert.equal(entry.distance, 3.1);

  // Edit: distance can change, but cannot be cleared in a distance challenge.
  const edited = await jsonFetch(`${origin}/api/activities/${entry.id}`, ann.cookie, 'PATCH', { distance: 4, distance_unit: 'mi' });
  assert.equal(edited.status, 200);
  const cleared = await jsonFetch(`${origin}/api/activities/${entry.id}`, ann.cookie, 'PATCH', { distance: '' });
  assert.equal(cleared.status, 400);

  // Switching the display unit converts the totals without touching stored entries.
  await jsonFetch(`${origin}/api/challenges/${challengeId}`, ann.cookie, 'PATCH', { distance_unit: 'km' });
  const lbKm = await jsonFetch(`${origin}/api/challenges/${challengeId}/leaderboard`, ann.cookie);
  assert.equal(lbKm.body.distance_unit, 'km');
  assert.equal(lbKm.body.teams[0].distance, 11.44); // 4 mi + 5 km
});

test('a minutes challenge still requires minutes and accepts distance as optional extra', async () => {
  const cat = await register('Cat Minutes');
  const c = await jsonFetch(`${origin}/api/challenges`, cat.cookie, 'POST', { name: 'Classic', start_date: '2027-07-01', end_date: '2027-07-31' });
  const t = await jsonFetch(`${origin}/api/teams`, cat.cookie, 'POST', { challenge_id: c.body.id, name: 'Clock Watchers' });
  const distOnly = await jsonFetch(`${origin}/api/activities`, cat.cookie, 'POST', { team_id: t.body.id, challenge_id: c.body.id, activity_type: 'Cycling', distance: 10, activity_date: '2027-07-02' });
  assert.equal(distOnly.status, 400);
  assert.match(distOnly.body.error, /minutes/i);
  const both = await jsonFetch(`${origin}/api/activities`, cat.cookie, 'POST', { team_id: t.body.id, challenge_id: c.body.id, activity_type: 'Cycling', minutes: 40, distance: 10, activity_date: '2027-07-02' });
  assert.equal(both.status, 201);
  const lb = await jsonFetch(`${origin}/api/challenges/${c.body.id}/leaderboard`, cat.cookie);
  assert.equal(lb.body.metric, 'minutes');
  assert.equal(lb.body.teams[0].minutes, 40);
});

test('health import carries distance in metres and skips sessions without the challenge measure', async () => {
  const dee = await register('Dee Sync');
  const { challengeId, teamId } = await distanceChallenge(dee);
  const r = await fetch(`${origin}/api/health/import`, {
    method: 'POST',
    headers: { authorization: `Bearer ${dee.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      source: 'health_kit',
      records: [
        { team_id: teamId, challenge_id: challengeId, activity_type: 'Running', minutes: 31, distance_m: 5000, activity_date: '2027-07-04', source_ref: 'run-1' },
        { team_id: teamId, challenge_id: challengeId, activity_type: 'Yoga', minutes: 45, activity_date: '2027-07-04', source_ref: 'yoga-1' },
        { team_id: teamId, challenge_id: challengeId, activity_type: 'Walking', distance_m: 1609.344, activity_date: '2027-07-05', source_ref: 'walk-1' },
        { team_id: teamId, challenge_id: challengeId, activity_type: 'Walking', distance_m: -3, activity_date: '2027-07-05', source_ref: 'bad-1' },
      ],
    }),
  });
  assert.deepEqual(await r.json(), { added: 2, skipped: 2 });
  const lb = await jsonFetch(`${origin}/api/challenges/${challengeId}/leaderboard`, dee.cookie);
  assert.equal(lb.body.users[0].distance, 4.11); // 5 km + 1 mi
  assert.equal(lb.body.users[0].minutes, 31);
});

test('CSV export of a distance challenge leads with the distance column', async () => {
  const eve = await register('Eve Export');
  const { challengeId, teamId } = await distanceChallenge(eve, { distance_unit: 'km' });
  await jsonFetch(`${origin}/api/activities`, eve.cookie, 'POST', { team_id: teamId, challenge_id: challengeId, activity_type: 'Running', distance: 10, minutes: 55, activity_date: '2027-07-02' });
  const teamsCsv = await (await fetch(`${origin}/api/challenges/${challengeId}/leaderboard/export?type=teams`, { headers: { cookie: eve.cookie } })).text();
  assert.match(teamsCsv, /^Rank,Team,Kilometres,Minutes\r\n1,Milers,10,55/);
  const usersCsv = await (await fetch(`${origin}/api/challenges/${challengeId}/leaderboard/export?type=users`, { headers: { cookie: eve.cookie } })).text();
  assert.match(usersCsv, new RegExp(`^Rank,Name,Email,Kilometres,Minutes\\r\\n1,Eve Export,${eve.email.replace(/\./g, '\\.')},10,55`));
});

test('an existing database from before distance challenges is migrated without losing activity', async () => {
  const { DatabaseSync } = require('node:sqlite');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'activity-challenge-legacy-'));
  const legacy = new DatabaseSync(path.join(dir, 'activity.sqlite'));
  // The original schema: minutes NOT NULL, no metric or distance columns anywhere.
  legacy.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE users(id INTEGER PRIMARY KEY,email TEXT UNIQUE NOT NULL,name TEXT NOT NULL,password_hash TEXT NOT NULL,role TEXT NOT NULL DEFAULT 'member',created_at TEXT DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE challenges(id INTEGER PRIMARY KEY,name TEXT NOT NULL,start_date TEXT NOT NULL,end_date TEXT NOT NULL,created_by INTEGER NOT NULL,invite_code TEXT UNIQUE NOT NULL,active INTEGER NOT NULL DEFAULT 1,created_at TEXT DEFAULT CURRENT_TIMESTAMP,FOREIGN KEY(created_by) REFERENCES users(id));
    CREATE TABLE teams(id INTEGER PRIMARY KEY,challenge_id INTEGER NOT NULL,name TEXT NOT NULL,created_by INTEGER NOT NULL,invite_code TEXT UNIQUE NOT NULL,created_at TEXT DEFAULT CURRENT_TIMESTAMP,FOREIGN KEY(challenge_id) REFERENCES challenges(id) ON DELETE CASCADE,FOREIGN KEY(created_by) REFERENCES users(id));
    CREATE TABLE activities(id INTEGER PRIMARY KEY,user_id INTEGER NOT NULL,team_id INTEGER NOT NULL,challenge_id INTEGER NOT NULL,activity_type TEXT NOT NULL,minutes INTEGER NOT NULL CHECK(minutes>0),activity_date TEXT NOT NULL,source TEXT NOT NULL DEFAULT 'manual',source_ref TEXT,created_at TEXT DEFAULT CURRENT_TIMESTAMP,UNIQUE(user_id,source,source_ref),FOREIGN KEY(user_id) REFERENCES users(id),FOREIGN KEY(team_id) REFERENCES teams(id),FOREIGN KEY(challenge_id) REFERENCES challenges(id));
    INSERT INTO users(id,email,name,password_hash) VALUES(1,'old@example.com','Old Timer','x:y');
    INSERT INTO challenges(id,name,start_date,end_date,created_by,invite_code) VALUES(1,'Legacy',date('now'),date('now','+30 days'),1,'LEGACY01');
    INSERT INTO teams(id,challenge_id,name,created_by,invite_code) VALUES(1,1,'Old Team',1,'LEGACYT1');
    INSERT INTO activities(user_id,team_id,challenge_id,activity_type,minutes,activity_date,source,source_ref) VALUES(1,1,1,'Walking',42,date('now'),'health_connect','old-ref');`);
  legacy.close();

  const srv = await spawnServer({ DATA_DIR: dir });
  try {
    const check = new DatabaseSync(path.join(dir, 'activity.sqlite'));
    const cols = check.prepare('PRAGMA table_info(activities)').all();
    assert.equal(cols.find(c => c.name === 'minutes').notnull, 0, 'minutes should now be optional');
    assert.equal(cols.find(c => c.name === 'team_id').notnull, 0, 'team should now be optional');
    assert.ok(cols.some(c => c.name === 'distance_m'));
    const row = check.prepare('SELECT * FROM activities').get();
    assert.equal(row.minutes, 42);
    assert.equal(row.source_ref, 'old-ref');
    assert.equal(check.prepare('SELECT metric FROM challenges WHERE id=1').get().metric, 'minutes');
    // The uniqueness rule survived the rebuild, now per challenge.
    assert.equal(check.prepare("SELECT group_concat(name) n FROM pragma_index_info((SELECT name FROM pragma_index_list('activities') WHERE origin='u'))").get().n, 'user_id,source,source_ref,challenge_id');
    assert.throws(() => check.prepare("INSERT INTO activities(user_id,team_id,challenge_id,activity_type,minutes,activity_date,source,source_ref) VALUES(1,1,1,'Walking',5,date('now'),'health_connect','old-ref')").run(), /UNIQUE/);
    check.close();
  } finally {
    await srv.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- deleting challenges, and individuals-only challenges ---------------------------------

test('a challenge owner can delete a challenge with everything in it; a member cannot', async () => {
  const owner = await register('Olive Owner');
  const member = await register('Max Member');
  const { challengeId, inviteCode, teamId } = await distanceChallenge(owner);
  await jsonFetch(`${origin}/api/join`, member.cookie, 'POST', { code: inviteCode });
  await jsonFetch(`${origin}/api/teams/${teamId}/join`, member.cookie, 'POST');
  await jsonFetch(`${origin}/api/activities`, member.cookie, 'POST', { team_id: teamId, challenge_id: challengeId, activity_type: 'Run', distance: 2, activity_date: '2027-07-02' });
  // A second challenge of the same owner must be untouched.
  const keep = await distanceChallenge(owner);
  await jsonFetch(`${origin}/api/activities`, owner.cookie, 'POST', { team_id: keep.teamId, challenge_id: keep.challengeId, activity_type: 'Run', distance: 1, activity_date: '2027-07-02' });

  const denied = await jsonFetch(`${origin}/api/challenges/${challengeId}`, member.cookie, 'DELETE');
  assert.equal(denied.status, 403);

  const done = await jsonFetch(`${origin}/api/challenges/${challengeId}`, owner.cookie, 'DELETE');
  assert.equal(done.status, 200);
  assert.equal((await jsonFetch(`${origin}/api/challenges/${challengeId}`, owner.cookie)).status, 403);
  const memberDash = await jsonFetch(`${origin}/api/dashboard`, member.cookie);
  assert.ok(!memberDash.body.challenges.some(c => c.id === challengeId));
  assert.ok(!memberDash.body.mine.some(a => a.challenge_id === challengeId), 'its activity is gone too');
  const kept = await jsonFetch(`${origin}/api/challenges/${keep.challengeId}/leaderboard`, owner.cookie);
  assert.equal(kept.body.users[0].distance, 1);
  assert.equal((await jsonFetch(`${origin}/api/challenges/${challengeId}`, owner.cookie, 'DELETE')).status, 404);
});

test('an individuals-only challenge has no teams: members log activity straight to it', async () => {
  const ivy = await register('Ivy Solo');
  const jon = await register('Jon Solo');
  const c = await jsonFetch(`${origin}/api/challenges`, ivy.cookie, 'POST', { name: 'Solo Steps', start_date: '2027-08-01', end_date: '2027-08-31', participation: 'individual' });
  assert.equal(c.status, 201);
  const cid = c.body.id;
  assert.equal((await jsonFetch(`${origin}/api/challenges/${cid}`, ivy.cookie)).body.participation, 'individual');

  const team = await jsonFetch(`${origin}/api/teams`, ivy.cookie, 'POST', { challenge_id: cid, name: 'Not allowed' });
  assert.equal(team.status, 400);

  // Not a member yet: refused.
  const outsider = await jsonFetch(`${origin}/api/activities`, jon.cookie, 'POST', { challenge_id: cid, activity_type: 'Walk', minutes: 20, activity_date: '2027-08-02' });
  assert.equal(outsider.status, 403);
  await jsonFetch(`${origin}/api/join`, jon.cookie, 'POST', { code: c.body.invite_code });

  assert.equal((await jsonFetch(`${origin}/api/activities`, ivy.cookie, 'POST', { challenge_id: cid, activity_type: 'Walk', minutes: 30, activity_date: '2027-08-02' })).status, 201);
  assert.equal((await jsonFetch(`${origin}/api/activities`, jon.cookie, 'POST', { challenge_id: cid, activity_type: 'Gym', minutes: 45, activity_date: '2027-08-02' })).status, 201);

  const lb = await jsonFetch(`${origin}/api/challenges/${cid}/leaderboard`, ivy.cookie);
  assert.equal(lb.body.participation, 'individual');
  assert.deepEqual(lb.body.teams, []);
  assert.deepEqual(lb.body.users.map(u => [u.name, u.minutes]), [['Jon Solo', 45], ['Ivy Solo', 30]]);

  const dash = await jsonFetch(`${origin}/api/dashboard`, ivy.cookie);
  const entry = dash.body.mine.find(a => a.challenge_id === cid);
  assert.equal(entry.team_id, null);
  assert.equal(entry.team_name, null);
  assert.equal(dash.body.challenges.find(x => x.id === cid).myMinutes, 30);

  // Device sync into it without a team id.
  const sync = await fetch(`${origin}/api/health/import`, {
    method: 'POST',
    headers: { authorization: `Bearer ${jon.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ source: 'health_connect', records: [{ challenge_id: cid, activity_type: 'Walking', minutes: 15, activity_date: '2027-08-03', source_ref: 'solo-1' }] }),
  });
  assert.deepEqual(await sync.json(), { added: 1, skipped: 0 });
  const boot = await jsonFetch(`${origin}/api/mobile/bootstrap`, jon.cookie);
  assert.equal(boot.body.challenges.find(x => x.id === cid).participation, 'individual');

  const editable = await jsonFetch(`${origin}/api/activities/${entry.id}`, ivy.cookie, 'PATCH', { minutes: 35 });
  assert.equal(editable.status, 200);
  const bad = await jsonFetch(`${origin}/api/challenges/${cid}`, ivy.cookie, 'PATCH', { participation: 'pairs' });
  assert.equal(bad.status, 400);
});

test('a team challenge can be switched to individuals only, keeping logged activity on the individual board', async () => {
  const kim = await register('Kim Switch');
  const { challengeId, teamId } = await distanceChallenge(kim);
  await jsonFetch(`${origin}/api/activities`, kim.cookie, 'POST', { team_id: teamId, challenge_id: challengeId, activity_type: 'Run', distance: 3, activity_date: '2027-07-02' });
  assert.equal((await jsonFetch(`${origin}/api/challenges/${challengeId}`, kim.cookie, 'PATCH', { participation: 'individual' })).status, 200);
  assert.equal((await jsonFetch(`${origin}/api/activities`, kim.cookie, 'POST', { challenge_id: challengeId, activity_type: 'Run', distance: 1, activity_date: '2027-07-03' })).status, 201);
  const lb = await jsonFetch(`${origin}/api/challenges/${challengeId}/leaderboard`, kim.cookie);
  assert.equal(lb.status, 200, JSON.stringify(lb.body));
  assert.equal(lb.body.users[0].distance, 4);
});

test('a database already migrated for distance is migrated again so team becomes optional', async () => {
  const { DatabaseSync } = require('node:sqlite');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'activity-challenge-midway-'));
  const db = new DatabaseSync(path.join(dir, 'activity.sqlite'));
  // Exactly what the distance release left behind: minutes optional, team_id still NOT NULL.
  db.exec(`CREATE TABLE users(id INTEGER PRIMARY KEY,email TEXT UNIQUE NOT NULL,name TEXT NOT NULL,password_hash TEXT NOT NULL,role TEXT NOT NULL DEFAULT 'member',created_at TEXT DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE challenges(id INTEGER PRIMARY KEY,name TEXT NOT NULL,start_date TEXT NOT NULL,end_date TEXT NOT NULL,created_by INTEGER NOT NULL,invite_code TEXT UNIQUE NOT NULL,active INTEGER NOT NULL DEFAULT 1,created_at TEXT DEFAULT CURRENT_TIMESTAMP,description TEXT,metric TEXT NOT NULL DEFAULT 'minutes',distance_unit TEXT NOT NULL DEFAULT 'mi');
    CREATE TABLE teams(id INTEGER PRIMARY KEY,challenge_id INTEGER NOT NULL,name TEXT NOT NULL,created_by INTEGER NOT NULL,invite_code TEXT UNIQUE NOT NULL,created_at TEXT DEFAULT CURRENT_TIMESTAMP,image_url TEXT);
    CREATE TABLE activities(id INTEGER PRIMARY KEY,user_id INTEGER NOT NULL,team_id INTEGER NOT NULL,challenge_id INTEGER NOT NULL,activity_type TEXT NOT NULL,minutes INTEGER CHECK(minutes>0),activity_date TEXT NOT NULL,source TEXT NOT NULL DEFAULT 'manual',source_ref TEXT,created_at TEXT DEFAULT CURRENT_TIMESTAMP,start_time TEXT,end_time TEXT,comment TEXT,distance_m REAL,UNIQUE(user_id,source,source_ref),FOREIGN KEY(user_id) REFERENCES users(id),FOREIGN KEY(team_id) REFERENCES teams(id),FOREIGN KEY(challenge_id) REFERENCES challenges(id));
    INSERT INTO users(id,email,name,password_hash) VALUES(1,'mid@example.com','Mid Way','x:y');
    INSERT INTO challenges(id,name,start_date,end_date,created_by,invite_code,metric) VALUES(1,'Midway',date('now'),date('now','+30 days'),1,'MIDWAY01','distance');
    INSERT INTO teams(id,challenge_id,name,created_by,invite_code) VALUES(1,1,'Mid Team',1,'MIDWAYT1');
    INSERT INTO activities(user_id,team_id,challenge_id,activity_type,distance_m,activity_date,comment) VALUES(1,1,1,'Run',5000,date('now'),'kept');`);
  db.close();
  const srv = await spawnServer({ DATA_DIR: dir });
  try {
    const check = new DatabaseSync(path.join(dir, 'activity.sqlite'));
    const cols = check.prepare('PRAGMA table_info(activities)').all();
    assert.equal(cols.find(c => c.name === 'team_id').notnull, 0);
    const row = check.prepare('SELECT * FROM activities').get();
    assert.deepEqual([row.team_id, row.distance_m, row.comment, row.minutes], [1, 5000, 'kept', null]);
    assert.equal(check.prepare('SELECT participation FROM challenges WHERE id=1').get().participation, 'teams');
    check.close();
  } finally {
    await srv.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('activity must fall within the challenge dates - manual, edited and synced', async () => {
  const lou = await register('Lou Window');
  const { challengeId, teamId } = await distanceChallenge(lou); // 2027-07-01 .. 2027-07-31
  const before = await jsonFetch(`${origin}/api/activities`, lou.cookie, 'POST', { team_id: teamId, challenge_id: challengeId, activity_type: 'Run', distance: 2, activity_date: '2027-06-30' });
  assert.equal(before.status, 400);
  assert.match(before.body.error, /2027-07-01 to 2027-07-31/);
  const lastDay = await jsonFetch(`${origin}/api/activities`, lou.cookie, 'POST', { team_id: teamId, challenge_id: challengeId, activity_type: 'Run', distance: 2, activity_date: '2027-07-31' });
  assert.equal(lastDay.status, 201);
  const dash = await jsonFetch(`${origin}/api/dashboard`, lou.cookie);
  const entry = dash.body.mine.find(a => a.challenge_id === challengeId);
  assert.equal((await jsonFetch(`${origin}/api/activities/${entry.id}`, lou.cookie, 'PATCH', { activity_date: '2027-08-01' })).status, 400);

  const sync = await fetch(`${origin}/api/health/import`, {
    method: 'POST',
    headers: { authorization: `Bearer ${lou.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ source: 'health_connect', records: [
      { team_id: teamId, challenge_id: challengeId, activity_type: 'Run', distance_m: 3000, activity_date: '2027-06-15', source_ref: 'old-run' },
      { team_id: teamId, challenge_id: challengeId, activity_type: 'Run', distance_m: 3000, activity_date: '2027-07-15', source_ref: 'in-run' },
    ] }),
  });
  assert.deepEqual(await sync.json(), { added: 1, skipped: 1 });

  const known = await fetch(`${origin}/api/health/synced`, {
    method: 'POST',
    headers: { authorization: `Bearer ${lou.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ source: 'health_connect', refs: ['in-run', 'old-run', 'never'] }),
  });
  assert.deepEqual(await known.json(), { synced: ['in-run'], syncedIn: { 'in-run': [challengeId] } });
});

// --- routes, several challenges per workout, and my activity ------------------------------

const ROUTE = Array.from({ length: 50 }, (_, i) => [51.5 + i * 0.0005, -0.12 + i * 0.0003, 1790000000000 + i * 10000, 20 + i * 0.1]);

test('one workout can be logged into several challenges at once, with one shared route only its owner can see', async () => {
  const mo = await register('Mo Multi');
  const other = await register('Nosy Neighbour');
  const a = await distanceChallenge(mo);
  const bC = await jsonFetch(`${origin}/api/challenges`, mo.cookie, 'POST', { name: 'Solo July', start_date: '2027-07-01', end_date: '2027-07-31', participation: 'individual', metric: 'distance' });
  const made = await jsonFetch(`${origin}/api/activities`, mo.cookie, 'POST', {
    targets: [{ challenge_id: a.challengeId, team_id: a.teamId }, { challenge_id: bC.body.id }],
    activity_type: 'Run', distance: 5, distance_unit: 'km', minutes: 27, activity_date: '2027-07-05', route: ROUTE,
  });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  assert.equal(made.body.created, 2);

  const mine = await jsonFetch(`${origin}/api/me/activities`, mo.cookie);
  const runs = mine.body.activities.filter(x => x.activity_date === '2027-07-05');
  assert.deepEqual(runs.map(x => x.challenge_name).sort(), ['Mileage Month', 'Solo July']);
  assert.ok(runs.every(x => x.has_route));

  const route = await jsonFetch(`${origin}/api/activities/${runs[0].id}/route`, mo.cookie);
  assert.equal(route.status, 200);
  assert.equal(route.body.points.length, 50);
  assert.deepEqual(route.body.points[0], [51.5, -0.12, 1790000000000, 20]);
  assert.equal((await jsonFetch(`${origin}/api/activities/${runs[0].id}/route`, other.cookie)).status, 404, 'nobody else can read a route');

  // All or none: one bad target refuses the whole thing.
  const bad = await jsonFetch(`${origin}/api/activities`, mo.cookie, 'POST', {
    targets: [{ challenge_id: a.challengeId, team_id: a.teamId }, { challenge_id: bC.body.id }],
    activity_type: 'Run', distance: 1, activity_date: '2027-08-05',
  });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /Mileage Month: .*2027-07-31/);

  // Deleting one entry keeps the route for the other; deleting both removes it.
  await jsonFetch(`${origin}/api/activities/${runs[0].id}`, mo.cookie, 'DELETE');
  assert.equal((await jsonFetch(`${origin}/api/activities/${runs[1].id}/route`, mo.cookie)).status, 200);
  await jsonFetch(`${origin}/api/activities/${runs[1].id}`, mo.cookie, 'DELETE');
  const { DatabaseSync } = require('node:sqlite');
  const check = new DatabaseSync(path.join(dataDir, 'activity.sqlite'));
  assert.equal(check.prepare("SELECT count(*) n FROM routes WHERE source_ref LIKE 'gpx-%' AND user_id=?").get(mo.user.id).n, 0);
  check.close();
});

test('a synced workout can go into every challenge it fits, its route stored once, and long routes are thinned', async () => {
  const pat = await register('Pat Sync');
  const a = await distanceChallenge(pat);
  const bC = await jsonFetch(`${origin}/api/challenges`, pat.cookie, 'POST', { name: 'Minutes July', start_date: '2027-07-01', end_date: '2027-07-31', participation: 'individual' });
  const long = Array.from({ length: 9000 }, (_, i) => [51 + i * 1e-5, 0.1 + i * 1e-5]);
  const rec = { activity_type: 'Ride', minutes: 60, distance_m: 20000, activity_date: '2027-07-06', source_ref: 'hc-ride-1', route: long };
  const r = await fetch(`${origin}/api/health/import`, {
    method: 'POST',
    headers: { authorization: `Bearer ${pat.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ source: 'health_connect', records: [{ ...rec, challenge_id: a.challengeId, team_id: a.teamId }, { ...rec, challenge_id: bC.body.id }] }),
  });
  assert.deepEqual(await r.json(), { added: 2, skipped: 0 });
  const known = await fetch(`${origin}/api/health/synced`, {
    method: 'POST',
    headers: { authorization: `Bearer ${pat.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ source: 'health_connect', refs: ['hc-ride-1'] }),
  });
  assert.deepEqual((await known.json()).syncedIn['hc-ride-1'].sort((x, y) => x - y), [a.challengeId, bC.body.id].sort((x, y) => x - y));
  const { DatabaseSync } = require('node:sqlite');
  const check = new DatabaseSync(path.join(dataDir, 'activity.sqlite'));
  const routes = check.prepare("SELECT point_count FROM routes WHERE source_ref='hc-ride-1'").all();
  check.close();
  assert.equal(routes.length, 1, 'one route row for the two entries');
  assert.equal(routes[0].point_count, 3000);

  // Syncing the same workout into a third challenge later, without the points, still links the route.
  const cC = await jsonFetch(`${origin}/api/challenges`, pat.cookie, 'POST', { name: 'Late joiner', start_date: '2027-07-01', end_date: '2027-07-31', participation: 'individual' });
  await fetch(`${origin}/api/health/import`, {
    method: 'POST',
    headers: { authorization: `Bearer ${pat.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ source: 'health_connect', records: [{ ...rec, route: undefined, challenge_id: cC.body.id }] }),
  });
  const late = (await jsonFetch(`${origin}/api/me/activities`, pat.cookie)).body.activities.find(x => x.challenge_id === cC.body.id);
  assert.equal(late.has_route, true);
});

// --- profiles and sharing levels ---------------------------------------------------------------

test('profiles: only challenge-mates can see each other, and the sharing level decides what they see', async () => {
  const una = await register('Una Profile');
  const vic = await register('Vic Mate');
  const wes = await register('Wes Stranger');
  const shared = await jsonFetch(`${origin}/api/challenges`, una.cookie, 'POST', { name: 'Shared Sept', start_date: '2027-09-01', end_date: '2027-09-30', participation: 'individual' });
  const secret = await jsonFetch(`${origin}/api/challenges`, una.cookie, 'POST', { name: 'Una Only', start_date: '2027-09-01', end_date: '2027-09-30', participation: 'individual' });
  await jsonFetch(`${origin}/api/join`, vic.cookie, 'POST', { code: shared.body.invite_code });
  await jsonFetch(`${origin}/api/activities`, una.cookie, 'POST', {
    targets: [{ challenge_id: shared.body.id }, { challenge_id: secret.body.id }],
    activity_type: 'Swim', minutes: 40, activity_date: '2027-09-02', comment: 'Felt great', route: ROUTE,
  });
  await jsonFetch(`${origin}/api/activities`, vic.cookie, 'POST', { challenge_id: shared.body.id, activity_type: 'Gym', minutes: 60, activity_date: '2027-09-02' });

  // Default is "summary": totals and rank in shared challenges only, no activity list.
  const p = await jsonFetch(`${origin}/api/users/${una.user.id}/profile`, vic.cookie);
  assert.equal(p.status, 200);
  assert.equal(p.body.sharing, 'summary');
  assert.deepEqual(p.body.challenges.map(c => [c.name, c.minutes, c.rank, c.of]), [['Shared Sept', 40, 2, 2]]);
  assert.equal(p.body.activities, undefined);
  assert.equal((await jsonFetch(`${origin}/api/users/${una.user.id}/profile`, wes.cookie)).status, 404, 'a stranger cannot see the profile at all');

  // Full: recent activity too - only from shared challenges, with comments, never routes.
  const set = await jsonFetch(`${origin}/api/me`, una.cookie, 'PATCH', { bio: 'Morning swimmer', profileSharing: 'full' });
  assert.equal(set.status, 200);
  assert.equal(set.body.user.profile_sharing, 'full');
  const full = await jsonFetch(`${origin}/api/users/${una.user.id}/profile`, vic.cookie);
  assert.equal(full.body.bio, 'Morning swimmer');
  assert.deepEqual(full.body.activities.map(a => [a.challenge_name, a.activity_type, a.comment]), [['Shared Sept', 'Swim', 'Felt great']]);
  assert.ok(!JSON.stringify(full.body).includes('route') && !JSON.stringify(full.body).includes('51.5'), 'no route data in a profile');

  // Private: name and photo only.
  await jsonFetch(`${origin}/api/me`, una.cookie, 'PATCH', { profileSharing: 'private' });
  const priv = await jsonFetch(`${origin}/api/users/${una.user.id}/profile`, vic.cookie);
  assert.equal(priv.body.name, 'Una Profile');
  assert.equal(priv.body.challenges, undefined);
  assert.equal(priv.body.activities, undefined);

  // Your own profile is the preview of what others see, but lists every challenge you're in.
  await jsonFetch(`${origin}/api/me`, una.cookie, 'PATCH', { profileSharing: 'summary' });
  const mine = await jsonFetch(`${origin}/api/users/${una.user.id}/profile`, una.cookie);
  assert.equal(mine.body.self, true);
  assert.deepEqual(mine.body.challenges.map(c => c.name).sort(), ['Shared Sept', 'Una Only']);

  assert.equal((await jsonFetch(`${origin}/api/me`, una.cookie, 'PATCH', { profileSharing: 'everyone' })).status, 400);
  const me = await jsonFetch(`${origin}/api/me`, una.cookie);
  assert.equal(me.body.user.bio, 'Morning swimmer');
});

// --- help & support tickets ------------------------------------------------------------------

async function adminCookie() {
  const r = await fetch(`${origin}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'admin@example.com', password: 'ChangeMe123!' }) });
  return r.headers.get('set-cookie').split(';')[0];
}

test('tickets: users report and follow their own; admins see all, reply, add internal notes and set the outcome', async () => {
  const xia = await register('Xia Reporter');
  const yan = await register('Yan Other');
  const admin = await adminCookie();

  const bad = await jsonFetch(`${origin}/api/tickets`, xia.cookie, 'POST', { type: 'complaint', title: 'x', description: 'y' });
  assert.equal(bad.status, 400);
  const made = await jsonFetch(`${origin}/api/tickets`, xia.cookie, 'POST', { type: 'bug', title: 'Sync skips my yoga', description: 'Yoga never appears in my distance challenge.', client_info: 'Android 15 · app 1.1.0' });
  assert.equal(made.status, 201);
  const id = made.body.id;

  const mine = await jsonFetch(`${origin}/api/tickets`, xia.cookie);
  assert.deepEqual(mine.body.tickets.map(t => [t.title, t.status, t.unread]), [['Sync skips my yoga', 'new', false]]);
  assert.equal(mine.body.tickets[0].client_info, undefined, 'device details are for admins');
  assert.equal((await jsonFetch(`${origin}/api/tickets?scope=all`, xia.cookie)).status, 403);
  assert.equal((await jsonFetch(`${origin}/api/tickets/${id}`, yan.cookie)).status, 404, 'other users cannot see it');
  assert.deepEqual((await jsonFetch(`${origin}/api/tickets`, yan.cookie)).body.tickets, []);

  // Admin dashboard: everything, counts, and the new ticket flagged unread for admins.
  const dash = await jsonFetch(`${origin}/api/tickets?scope=all`, admin);
  const row = dash.body.tickets.find(t => t.id === id);
  assert.equal(row.unread, true);
  assert.equal(row.client_info, 'Android 15 · app 1.1.0');
  assert.equal(row.reporter.email, xia.email);
  assert.ok(dash.body.counts.new >= 1);
  assert.ok((await jsonFetch(`${origin}/api/tickets/badge`, admin)).body.admin >= 1);

  // Admin opens it (seen), adds an internal note and a reply, and sets the outcome.
  await jsonFetch(`${origin}/api/tickets/${id}`, admin);
  assert.equal((await jsonFetch(`${origin}/api/tickets/${id}/comments`, admin, 'POST', { body: 'Probably the distance filter', internal: true })).status, 201);
  assert.equal((await jsonFetch(`${origin}/api/tickets/${id}/comments`, admin, 'POST', { body: 'Thanks - yoga has no distance, so it only counts in minutes challenges.' })).status, 201);
  assert.equal((await jsonFetch(`${origin}/api/tickets/${id}`, xia.cookie, 'PATCH', { status: 'done' })).status, 403, 'only admins change status');
  assert.equal((await jsonFetch(`${origin}/api/tickets/${id}`, admin, 'PATCH', { status: 'declined', resolution: 'Working as intended.' })).status, 200);
  assert.equal((await jsonFetch(`${origin}/api/tickets/${id}`, admin, 'PATCH', { status: 'lost' })).status, 400);

  // The reporter sees the reply and outcome (not the internal note), with a badge until they look.
  assert.equal((await jsonFetch(`${origin}/api/tickets/badge`, xia.cookie)).body.mine, 1);
  const seen = await jsonFetch(`${origin}/api/tickets/${id}`, xia.cookie);
  assert.equal(seen.body.status, 'declined');
  assert.equal(seen.body.resolution, 'Working as intended.');
  assert.deepEqual(seen.body.comments.map(c => [c.body.slice(0, 6), c.from_support]), [['Thanks', true]]);
  assert.equal((await jsonFetch(`${origin}/api/tickets/badge`, xia.cookie)).body.mine, 0);

  // A reply from the reporter flags it for admins again.
  await jsonFetch(`${origin}/api/tickets/${id}/comments`, xia.cookie, 'POST', { body: 'Makes sense, thanks!' });
  const again = await jsonFetch(`${origin}/api/tickets?scope=all&status=declined`, admin);
  assert.equal(again.body.tickets.find(t => t.id === id).unread, true);
  const adminView = await jsonFetch(`${origin}/api/tickets/${id}`, admin);
  assert.deepEqual(adminView.body.comments.map(c => c.internal), [true, false, false]);
});

test('global admins can list every user and challenge, and open any challenge they are not in', async () => {
  const zed = await register('Zed Owner');
  const c = await jsonFetch(`${origin}/api/challenges`, zed.cookie, 'POST', { name: 'Admin Visible', start_date: '2027-10-01', end_date: '2027-10-31', participation: 'individual' });
  await jsonFetch(`${origin}/api/activities`, zed.cookie, 'POST', { challenge_id: c.body.id, activity_type: 'Run', minutes: 20, activity_date: '2027-10-02' });
  const admin = await adminCookie();
  const outsider = await register('Out Sider');

  assert.equal((await jsonFetch(`${origin}/api/admin/challenges`, outsider.cookie)).status, 403);
  const list = await jsonFetch(`${origin}/api/admin/challenges`, admin);
  const row = list.body.challenges.find(x => x.id === c.body.id);
  assert.deepEqual([row.owners, row.members, row.activities, row.purge_date], ['Zed Owner', 1, 1, '2027-12-31']);

  const users = await jsonFetch(`${origin}/api/admin/users`, admin);
  const zrow = users.body.users.find(x => x.email === zed.email);
  assert.deepEqual([zrow.challenges, zrow.activities, zrow.last_activity], [1, 1, '2027-10-02']);

  const view = await jsonFetch(`${origin}/api/challenges/${c.body.id}`, admin);
  assert.equal(view.status, 200);
  assert.equal(view.body.role, 'admin');
  assert.equal(view.body.canManage, true);
  assert.equal((await jsonFetch(`${origin}/api/challenges/${c.body.id}/leaderboard`, admin)).status, 200);
  assert.equal((await jsonFetch(`${origin}/api/challenges/${c.body.id}`, outsider.cookie)).status, 403);
  assert.equal((await jsonFetch(`${origin}/api/challenges/999999`, admin)).status, 404);

  const r = await fetch(`${origin}/api/dashboard`, { headers: { cookie: zed.cookie } });
  assert.equal(r.headers.get('cache-control'), 'no-store');
});

test('global admins can deactivate, reactivate and delete accounts, with guards', async () => {
  const admin = await adminCookie();
  const login = (email) => fetch(`${origin}/api/mobile/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: 'SuperSecret123!' }) });
  const dee = await register('Dee Activate');
  const owner = await register('Own Er');
  const c = await jsonFetch(`${origin}/api/challenges`, dee.cookie, 'POST', { name: 'Dee Made This', start_date: '2027-10-01', end_date: '2027-10-31' });
  await jsonFetch(`${origin}/api/join`, owner.cookie, 'POST', { code: c.body.invite_code });
  const t = await jsonFetch(`${origin}/api/teams`, dee.cookie, 'POST', { challenge_id: c.body.id, name: 'Dee Team' });
  await jsonFetch(`${origin}/api/activities`, dee.cookie, 'POST', { challenge_id: c.body.id, team_id: t.body.id, activity_type: 'Run', minutes: 30, activity_date: '2027-10-02' });
  await jsonFetch(`${origin}/api/tickets`, dee.cookie, 'POST', { type: 'bug', title: 'It broke', description: 'details' });
  const users = async () => (await jsonFetch(`${origin}/api/admin/users`, admin)).body.users;
  const deeId = (await users()).find(x => x.email === dee.email).id;

  // members can't
  assert.equal((await jsonFetch(`${origin}/api/admin/users/${deeId}`, owner.cookie, 'DELETE')).status, 403);

  // deactivate: signed out everywhere, can't sign in, activity still counts
  assert.equal((await jsonFetch(`${origin}/api/admin/users/${deeId}`, admin, 'PATCH', { active: false })).status, 200);
  assert.deepEqual((await jsonFetch(`${origin}/api/me`, dee.cookie)).body, { user: null });
  const blocked = await login(dee.email);
  assert.equal(blocked.status, 403);
  assert.match((await blocked.json()).error, /deactivated/);
  assert.ok((await users()).find(x => x.id === deeId).deactivated_at);
  const board = await jsonFetch(`${origin}/api/challenges/${c.body.id}/leaderboard`, owner.cookie);
  assert.equal(board.body.users.find(x => x.name === 'Dee Activate').minutes, 30);

  // reactivate
  await jsonFetch(`${origin}/api/admin/users/${deeId}`, admin, 'PATCH', { active: true });
  assert.equal((await login(dee.email)).status, 200);

  // guards: not yourself, not the built-in admin (being another admin means one always remains)
  const me = (await jsonFetch(`${origin}/api/me`, admin)).body.user;
  assert.match((await jsonFetch(`${origin}/api/admin/users/${me.id}`, admin, 'PATCH', { active: false })).body.error, /your own account/);
  assert.match((await jsonFetch(`${origin}/api/admin/users/${me.id}`, admin, 'DELETE')).body.error, /your own account/);
  const ada = await register('Ada Admin');
  const adaId = (await users()).find(x => x.email === ada.email).id;
  await jsonFetch(`${origin}/api/admin/users/${adaId}`, admin, 'PATCH', { role: 'global_admin' });
  const adaLogin = await (await login(ada.email)).json();
  const asAda = (path, method, body) => fetch(`${origin}${path}`, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adaLogin.sessionToken}` }, body: body && JSON.stringify(body) }).then(async r => ({ status: r.status, body: await r.json() }));
  assert.match((await asAda(`/api/admin/users/${me.id}`, 'DELETE')).body.error, /built-in admin/);
  const admin2 = await adminCookie();

  // delete: the account, its activity and tickets go; the challenge and team it made stay
  assert.equal((await jsonFetch(`${origin}/api/admin/users/${deeId}`, admin2, 'DELETE')).status, 200);
  assert.ok(!(await jsonFetch(`${origin}/api/admin/users`, admin2)).body.users.some(x => x.id === deeId));
  assert.equal((await login(dee.email)).status, 401);
  const ch = (await jsonFetch(`${origin}/api/admin/challenges`, admin2)).body.challenges.find(x => x.id === c.body.id);
  assert.deepEqual([ch.activities, ch.teams, ch.members], [0, 1, 1]);
  const tickets = (await jsonFetch(`${origin}/api/tickets?scope=all&status=`, admin2)).body.tickets;
  assert.ok(!tickets.some(x => x.title === 'It broke'));
});

test('the Android app downloads for signed-in users once published', async () => {
  const viv = await register('Viv Download');
  assert.deepEqual((await jsonFetch(`${origin}/api/app/android`, viv.cookie)).body, { available: false });
  assert.equal((await fetch(`${origin}/api/app/android/download`, { headers: { cookie: viv.cookie } })).status, 404);

  const dir = path.join(dataDir, 'downloads');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'ActiveTogether.apk'), Buffer.from('PK fake apk bytes'));
  fs.writeFileSync(path.join(dir, 'android.json'), JSON.stringify({ version: '9.9.9', versionCode: 99, sha256: 'abc', published: '2027-01-01T00:00:00Z' }));

  const info = (await jsonFetch(`${origin}/api/app/android`, viv.cookie)).body;
  assert.deepEqual([info.available, info.version, info.size], [true, '9.9.9', 17]);
  assert.equal((await fetch(`${origin}/api/app/android/download`)).status, 401);
  const r = await fetch(`${origin}/api/app/android/download`, { headers: { cookie: viv.cookie } });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'application/vnd.android.package-archive');
  assert.match(r.headers.get('content-disposition'), /filename="ActiveTogether-9\.9\.9\.apk"/);
  assert.equal(await r.text(), 'PK fake apk bytes');
  fs.rmSync(dir, { recursive: true, force: true });
});
