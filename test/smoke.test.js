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
