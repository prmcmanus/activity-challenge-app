'use strict';
const http=require('node:http'), fs=require('node:fs'), path=require('node:path'), crypto=require('node:crypto');
const {DatabaseSync}=require('node:sqlite');
const PORT=Number(process.env.PORT||3000), DATA=process.env.DATA_DIR||'.', ORIGIN=process.env.APP_ORIGIN||`http://localhost:${PORT}`;
fs.mkdirSync(DATA,{recursive:true}); const db=new DatabaseSync(path.join(DATA,'activity.sqlite'));
db.exec(`PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY,email TEXT UNIQUE NOT NULL,name TEXT NOT NULL,password_hash TEXT NOT NULL,role TEXT NOT NULL DEFAULT 'member',created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS sessions(token_hash TEXT PRIMARY KEY,user_id INTEGER NOT NULL,expires_at TEXT NOT NULL,FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE);
CREATE TABLE IF NOT EXISTS challenges(id INTEGER PRIMARY KEY,name TEXT NOT NULL,start_date TEXT NOT NULL,end_date TEXT NOT NULL,created_by INTEGER NOT NULL,invite_code TEXT UNIQUE NOT NULL,active INTEGER NOT NULL DEFAULT 1,created_at TEXT DEFAULT CURRENT_TIMESTAMP,FOREIGN KEY(created_by) REFERENCES users(id));
CREATE TABLE IF NOT EXISTS challenge_members(challenge_id INTEGER,user_id INTEGER,challenge_role TEXT NOT NULL DEFAULT 'member',joined_at TEXT DEFAULT CURRENT_TIMESTAMP,PRIMARY KEY(challenge_id,user_id),FOREIGN KEY(challenge_id) REFERENCES challenges(id) ON DELETE CASCADE,FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE);
CREATE TABLE IF NOT EXISTS teams(id INTEGER PRIMARY KEY,challenge_id INTEGER NOT NULL,name TEXT NOT NULL,created_by INTEGER NOT NULL,invite_code TEXT UNIQUE NOT NULL,created_at TEXT DEFAULT CURRENT_TIMESTAMP,FOREIGN KEY(challenge_id) REFERENCES challenges(id) ON DELETE CASCADE,FOREIGN KEY(created_by) REFERENCES users(id));
CREATE TABLE IF NOT EXISTS team_members(team_id INTEGER,user_id INTEGER,team_role TEXT NOT NULL DEFAULT 'member',PRIMARY KEY(team_id,user_id),FOREIGN KEY(team_id) REFERENCES teams(id) ON DELETE CASCADE,FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE);
CREATE TABLE IF NOT EXISTS invites(id INTEGER PRIMARY KEY,team_id INTEGER NOT NULL,email TEXT NOT NULL,token TEXT UNIQUE NOT NULL,team_role TEXT NOT NULL DEFAULT 'member',expires_at TEXT NOT NULL,accepted_at TEXT,created_by INTEGER NOT NULL,FOREIGN KEY(team_id) REFERENCES teams(id) ON DELETE CASCADE);
CREATE TABLE IF NOT EXISTS activities(id INTEGER PRIMARY KEY,user_id INTEGER NOT NULL,team_id INTEGER NOT NULL,challenge_id INTEGER NOT NULL,activity_type TEXT NOT NULL,minutes INTEGER NOT NULL CHECK(minutes>0),activity_date TEXT NOT NULL,source TEXT NOT NULL DEFAULT 'manual',source_ref TEXT,created_at TEXT DEFAULT CURRENT_TIMESTAMP,UNIQUE(user_id,source,source_ref),FOREIGN KEY(user_id) REFERENCES users(id),FOREIGN KEY(team_id) REFERENCES teams(id),FOREIGN KEY(challenge_id) REFERENCES challenges(id));`);

const hash=p=>{const salt=crypto.randomBytes(16).toString('hex');return salt+':'+crypto.scryptSync(p,salt,64).toString('hex')};
const verify=(p,h)=>{const [s,k]=h.split(':');return crypto.timingSafeEqual(Buffer.from(k,'hex'),crypto.scryptSync(p,s,64))};

// Excludes 0/O/1/I/L to avoid transcription mistakes when someone reads a code aloud or off a screen.
const CODE_ALPHABET='ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const genCode=(len=8)=>{const b=crypto.randomBytes(len);let s='';for(let i=0;i<len;i++)s+=CODE_ALPHABET[b[i]%CODE_ALPHABET.length];return s};
const isUniqueViolation=e=>/UNIQUE constraint failed/i.test(e.message||'');

function insertChallenge(name,start_date,end_date,uid){
  for(let attempt=0;attempt<10;attempt++){
    const code=genCode();
    try{
      const r=db.prepare('INSERT INTO challenges(name,start_date,end_date,created_by,invite_code) VALUES(?,?,?,?,?)').run(name,start_date,end_date,uid,code);
      const id=Number(r.lastInsertRowid);
      db.prepare("INSERT INTO challenge_members(challenge_id,user_id,challenge_role) VALUES(?,?,'owner')").run(id,uid);
      return {id,invite_code:code};
    }catch(e){ if(isUniqueViolation(e))continue; throw e; }
  }
  throw new Error('Could not allocate a unique invite code');
}
function insertTeam(challengeId,name,uid){
  for(let attempt=0;attempt<10;attempt++){
    const code=genCode();
    try{
      const r=db.prepare('INSERT INTO teams(challenge_id,name,created_by,invite_code) VALUES(?,?,?,?)').run(challengeId,name,uid,code);
      const id=Number(r.lastInsertRowid);
      db.prepare("INSERT INTO team_members(team_id,user_id,team_role) VALUES(?,?,'team_admin')").run(id,uid);
      return {id,invite_code:code};
    }catch(e){ if(isUniqueViolation(e))continue; throw e; }
  }
  throw new Error('Could not allocate a unique invite code');
}

const seedEmail=(process.env.SEED_ADMIN_EMAIL||'admin@example.com').toLowerCase(), seedPass=process.env.SEED_ADMIN_PASSWORD||'ChangeMe123!';
let seedAdmin=db.prepare('SELECT id FROM users WHERE email=?').get(seedEmail);
if(!seedAdmin){
  db.prepare("INSERT INTO users(email,name,password_hash,role) VALUES(?,?,?,'global_admin')").run(seedEmail,'Administrator',hash(seedPass));
  seedAdmin=db.prepare('SELECT id FROM users WHERE email=?').get(seedEmail);
}
if(!db.prepare('SELECT id FROM challenges LIMIT 1').get()){
  const now=new Date(), end=new Date(now); end.setDate(end.getDate()+30);
  const {id}=insertChallenge('30-Day Activity Challenge',now.toISOString().slice(0,10),end.toISOString().slice(0,10),seedAdmin.id);
  insertTeam(id,'Team Alpha',seedAdmin.id);
}

const send=(res,status,data,headers={})=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8',...headers});res.end(JSON.stringify(data))};
const body=async req=>{let s='';for await(const c of req){s+=c;if(s.length>1e6)throw Error('Too large')}return s?JSON.parse(s):{}};
const cookies=req=>Object.fromEntries((req.headers.cookie||'').split(';').filter(Boolean).map(x=>x.trim().split('=')));
function sessionToken(req){const bearer=(req.headers.authorization||'').match(/^Bearer (.+)$/i);return bearer?.[1]||cookies(req).session||null}
function auth(req){const t=sessionToken(req);if(!t)return null;return db.prepare(`SELECT u.id,u.email,u.name,u.role FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>datetime('now')`).get(crypto.createHash('sha256').update(t).digest('hex'))||null}
const need=(res,u,roles)=>{if(!u){send(res,401,{error:'Sign in required'});return false}if(roles&&!roles.includes(u.role)){send(res,403,{error:'Not authorised'});return false}return true};
const setSessionCookie=t=>({'Set-Cookie':`session=${t}; HttpOnly; SameSite=Strict; Path=/; Max-Age=604800`});
function startSession(uid){const t=crypto.randomBytes(32).toString('hex'),th=crypto.createHash('sha256').update(t).digest('hex');db.prepare("INSERT INTO sessions VALUES(?,?,datetime('now','+7 days'))").run(th,uid);return t}

function teamAccess(uid,tid){return db.prepare('SELECT team_role FROM team_members WHERE user_id=? AND team_id=?').get(uid,tid)}
function challengeAccess(uid,cid){return db.prepare('SELECT challenge_role FROM challenge_members WHERE user_id=? AND challenge_id=?').get(uid,cid)}

function dashboard(uid){
  const challenges=db.prepare(`SELECT c.id,c.name,c.start_date,c.end_date,c.active,c.invite_code,cm.challenge_role FROM challenges c JOIN challenge_members cm ON cm.challenge_id=c.id WHERE cm.user_id=? ORDER BY c.start_date DESC`).all(uid);
  for(const c of challenges){
    c.role=c.challenge_role; delete c.challenge_role;
    c.teams=db.prepare(`SELECT t.id,t.name,t.invite_code,tm.team_role,(SELECT COUNT(*) FROM team_members z WHERE z.team_id=t.id) members FROM teams t JOIN team_members tm ON tm.team_id=t.id WHERE tm.user_id=? AND t.challenge_id=? ORDER BY t.name`).all(uid,c.id);
    c.myMinutes=db.prepare('SELECT COALESCE(SUM(minutes),0) m FROM activities WHERE user_id=? AND challenge_id=?').get(uid,c.id).m;
  }
  const mine=db.prepare(`SELECT a.*,t.name team_name,c.name challenge_name FROM activities a JOIN teams t ON t.id=a.team_id JOIN challenges c ON c.id=a.challenge_id WHERE a.user_id=? ORDER BY activity_date DESC,a.id DESC LIMIT 20`).all(uid);
  return {challenges,mine};
}

async function api(req,res,url){const u=auth(req), m=req.method;
 if(m==='POST'&&url.pathname==='/api/register'){const b=await body(req),email=String(b.email||'').toLowerCase().trim(),name=String(b.name||'').trim();if(!name||!email||!b.password||String(b.password).length<8)return send(res,400,{error:'Name, email and a password of at least 8 characters are required'});try{const r=db.prepare("INSERT INTO users(email,name,password_hash,role) VALUES(?,?,?,'member')").run(email,name,hash(b.password));const uid=Number(r.lastInsertRowid),t=startSession(uid);return send(res,201,{ok:true,sessionToken:t,user:{id:uid,email,name,role:'member'}},setSessionCookie(t))}catch(e){if(isUniqueViolation(e))return send(res,409,{error:'An account with that email already exists'});throw e}}
 if(m==='POST'&&url.pathname==='/api/login'){const b=await body(req),x=db.prepare('SELECT * FROM users WHERE email=?').get(String(b.email||'').toLowerCase());if(!x||!verify(b.password||'',x.password_hash))return send(res,401,{error:'Invalid email or password'});const t=startSession(x.id);return send(res,200,{ok:true,sessionToken:t,user:{id:x.id,email:x.email,name:x.name,role:x.role}},setSessionCookie(t))}
 if(m==='POST'&&url.pathname==='/api/logout'){if(u){const t=sessionToken(req);db.prepare('DELETE FROM sessions WHERE token_hash=?').run(crypto.createHash('sha256').update(t).digest('hex'))}return send(res,200,{ok:true},{'Set-Cookie':'session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0'})}
 if(m==='GET'&&url.pathname==='/api/me')return send(res,200,{user:u});
 if(m==='GET'&&url.pathname==='/api/dashboard'){if(!need(res,u))return;return send(res,200,{user:u,...dashboard(u.id)})}
 if(m==='GET'&&url.pathname==='/api/mobile/bootstrap'){if(!need(res,u))return;return send(res,200,{user:u,...dashboard(u.id),health:{healthConnect:{platform:'Android',mode:'native-companion-required'},healthKit:{platform:'iOS',mode:'native-companion-required'},acceptedRecord:'exercise session duration',uploadEndpoint:'/api/health/import'}})}

 if(m==='POST'&&url.pathname==='/api/challenges'){if(!need(res,u))return;const b=await body(req);if(!b.name||!b.start_date||!b.end_date)return send(res,400,{error:'name, start_date and end_date are required'});const {id,invite_code}=insertChallenge(String(b.name).trim(),b.start_date,b.end_date,u.id);return send(res,201,{id,invite_code})}
 if(m==='GET'&&url.pathname.match(/^\/api\/challenges\/\d+$/)){if(!need(res,u))return;const cid=Number(url.pathname.split('/')[3]),ca=challengeAccess(u.id,cid);if(!ca)return send(res,403,{error:'You need an invite code to view this challenge'});const c=db.prepare('SELECT id,name,start_date,end_date,active,invite_code,created_by FROM challenges WHERE id=?').get(cid);const teams=db.prepare(`SELECT t.id,t.name,t.invite_code,(SELECT COUNT(*) FROM team_members z WHERE z.team_id=t.id) members,EXISTS(SELECT 1 FROM team_members z WHERE z.team_id=t.id AND z.user_id=?) mine FROM teams t WHERE t.challenge_id=? ORDER BY t.name`).all(u.id,cid).map(t=>({id:t.id,name:t.name,members:t.members,mine:!!t.mine,invite_code:t.mine?t.invite_code:undefined}));return send(res,200,{...c,role:ca.challenge_role,teams})}
 if(m==='GET'&&url.pathname.match(/^\/api\/challenges\/\d+\/leaderboard$/)){if(!need(res,u))return;const cid=Number(url.pathname.split('/')[3]);if(!challengeAccess(u.id,cid))return send(res,403,{error:'You need an invite code to view this challenge'});const teams=db.prepare(`SELECT t.id,t.name,COALESCE(SUM(a.minutes),0) minutes FROM teams t LEFT JOIN activities a ON a.team_id=t.id WHERE t.challenge_id=? GROUP BY t.id ORDER BY minutes DESC,t.name`).all(cid);const users=db.prepare(`SELECT us.id,us.name,COALESCE(SUM(a.minutes),0) minutes FROM challenge_members cmem JOIN users us ON us.id=cmem.user_id LEFT JOIN activities a ON a.user_id=us.id AND a.challenge_id=cmem.challenge_id WHERE cmem.challenge_id=? GROUP BY us.id ORDER BY minutes DESC,us.name`).all(cid);return send(res,200,{teams,users})}

 if(m==='POST'&&url.pathname==='/api/join'){if(!need(res,u))return;const b=await body(req),code=String(b.code||'').trim().toUpperCase();if(!code)return send(res,400,{error:'Invite code required'});const challenge=db.prepare('SELECT * FROM challenges WHERE invite_code=?').get(code);if(challenge){db.prepare("INSERT OR IGNORE INTO challenge_members(challenge_id,user_id,challenge_role) VALUES(?,?,'member')").run(challenge.id,u.id);return send(res,200,{ok:true,type:'challenge',challengeId:challenge.id,name:challenge.name})}const team=db.prepare('SELECT * FROM teams WHERE invite_code=?').get(code);if(team){db.prepare("INSERT OR IGNORE INTO challenge_members(challenge_id,user_id,challenge_role) VALUES(?,?,'member')").run(team.challenge_id,u.id);db.prepare("INSERT OR IGNORE INTO team_members(team_id,user_id,team_role) VALUES(?,?,'member')").run(team.id,u.id);return send(res,200,{ok:true,type:'team',challengeId:team.challenge_id,teamId:team.id,name:team.name})}return send(res,400,{error:'That invite code was not recognised'})}

 if(m==='POST'&&url.pathname==='/api/teams'){if(!need(res,u))return;const b=await body(req),cid=Number(b.challenge_id);if(!b.name||!cid)return send(res,400,{error:'challenge_id and name are required'});if(!challengeAccess(u.id,cid))return send(res,403,{error:'Join the challenge before creating a team in it'});const {id,invite_code}=insertTeam(cid,String(b.name).trim(),u.id);return send(res,201,{id,invite_code})}
 if(m==='POST'&&url.pathname.match(/^\/api\/teams\/\d+\/join$/)){if(!need(res,u))return;const tid=Number(url.pathname.split('/')[3]),team=db.prepare('SELECT * FROM teams WHERE id=?').get(tid);if(!team)return send(res,404,{error:'Team not found'});if(!challengeAccess(u.id,team.challenge_id))return send(res,403,{error:'Join the challenge before joining one of its teams'});db.prepare("INSERT OR IGNORE INTO team_members(team_id,user_id,team_role) VALUES(?,?,'member')").run(tid,u.id);return send(res,200,{ok:true})}
 if(m==='POST'&&url.pathname.match(/^\/api\/teams\/\d+\/invite$/)){if(!need(res,u))return;const tid=Number(url.pathname.split('/')[3]),ta=teamAccess(u.id,tid);if(u.role!=='global_admin'&&ta?.team_role!=='team_admin')return send(res,403,{error:'Team admin required'});const b=await body(req),token=crypto.randomBytes(24).toString('hex'),exp=new Date(Date.now()+7*864e5).toISOString();db.prepare('INSERT INTO invites(team_id,email,token,team_role,expires_at,created_by) VALUES(?,?,?,?,?,?)').run(tid,String(b.email).toLowerCase(),token,b.team_role||'member',exp,u.id);return send(res,201,{inviteUrl:`${ORIGIN}/?invite=${token}`,expiresAt:exp})}
 if(m==='POST'&&url.pathname==='/api/invites/accept'){if(!need(res,u))return;const b=await body(req),inv=db.prepare("SELECT * FROM invites WHERE token=? AND accepted_at IS NULL AND expires_at>datetime('now')").get(b.token);if(!inv)return send(res,400,{error:'Invite invalid or expired'});if(inv.email!==u.email)return send(res,403,{error:'This invite was issued to another email address'});const team=db.prepare('SELECT challenge_id FROM teams WHERE id=?').get(inv.team_id);db.prepare("INSERT OR IGNORE INTO challenge_members(challenge_id,user_id,challenge_role) VALUES(?,?,'member')").run(team.challenge_id,u.id);db.prepare('INSERT OR REPLACE INTO team_members(team_id,user_id,team_role) VALUES(?,?,?)').run(inv.team_id,u.id,inv.team_role);db.prepare("UPDATE invites SET accepted_at=datetime('now') WHERE id=?").run(inv.id);return send(res,200,{ok:true,challengeId:team.challenge_id,teamId:inv.team_id})}

 if(m==='POST'&&url.pathname==='/api/activities'){if(!need(res,u))return;const b=await body(req),teamId=Number(b.team_id),challengeId=Number(b.challenge_id),team=db.prepare('SELECT challenge_id FROM teams WHERE id=?').get(teamId);if(!team||team.challenge_id!==challengeId)return send(res,400,{error:'That team is not part of this challenge'});if(!teamAccess(u.id,teamId))return send(res,403,{error:'You are not in this team'});try{db.prepare('INSERT INTO activities(user_id,team_id,challenge_id,activity_type,minutes,activity_date,source,source_ref) VALUES(?,?,?,?,?,?,?,?)').run(u.id,teamId,challengeId,b.activity_type,Number(b.minutes),b.activity_date,b.source||'manual',b.source_ref||null);return send(res,201,{ok:true})}catch(e){return send(res,400,{error:'Invalid or duplicate activity'})}}

 if(m==='GET'&&url.pathname==='/api/admin/users'){if(!need(res,u,['global_admin']))return;return send(res,200,{users:db.prepare('SELECT id,email,name,role,created_at FROM users ORDER BY name').all()})}
 if(m==='POST'&&url.pathname==='/api/admin/users'){if(!need(res,u,['global_admin']))return;const b=await body(req);try{const r=db.prepare('INSERT INTO users(email,name,password_hash,role) VALUES(?,?,?,?)').run(String(b.email).toLowerCase(),b.name,hash(b.password),b.role||'member');return send(res,201,{id:Number(r.lastInsertRowid)})}catch(e){return send(res,400,{error:'Email already exists or fields are invalid'})}}
 if(m==='PATCH'&&url.pathname.match(/^\/api\/admin\/users\/\d+$/)){if(!need(res,u,['global_admin']))return;const id=Number(url.pathname.split('/').pop()),b=await body(req);db.prepare('UPDATE users SET role=? WHERE id=?').run(b.role,id);return send(res,200,{ok:true})}

 if(m==='GET'&&url.pathname==='/api/health/status'){if(!need(res,u))return;return send(res,200,{healthConnect:{platform:'Android',mode:'native-companion-required'},healthKit:{platform:'iOS',mode:'native-companion-required'},acceptedRecord:'exercise session duration',uploadEndpoint:'/api/health/import'})}
 if(m==='POST'&&url.pathname==='/api/health/import'){if(!need(res,u))return;const b=await body(req);if(!Array.isArray(b.records))return send(res,400,{error:'records array required'});if(!['health_connect','health_kit'].includes(b.source))return send(res,400,{error:'source must be health_connect or health_kit'});let added=0,skipped=0;for(const x of b.records){const teamId=Number(x.team_id),challengeId=Number(x.challenge_id),minutes=Number(x.minutes),team=db.prepare('SELECT challenge_id FROM teams WHERE id=?').get(teamId);if(!team||team.challenge_id!==challengeId||!teamAccess(u.id,teamId)||!Number.isInteger(minutes)||minutes<=0||!x.activity_date||!x.source_ref){skipped++;continue}try{db.prepare('INSERT INTO activities(user_id,team_id,challenge_id,activity_type,minutes,activity_date,source,source_ref) VALUES(?,?,?,?,?,?,?,?)').run(u.id,teamId,challengeId,x.activity_type||'Synced activity',minutes,x.activity_date,b.source,x.source_ref);added++}catch(e){skipped++}}return send(res,200,{added,skipped})}
 return send(res,404,{error:'Not found'});
}
const server=http.createServer(async(req,res)=>{try{const url=new URL(req.url,ORIGIN);if(url.pathname.startsWith('/api/'))return await api(req,res,url);let p=url.pathname==='/'?'index.html':url.pathname.slice(1);p=path.normalize(p).replace(/^\.\.(\/|\\|$)/,'');const f=path.join(__dirname,'public',p);if(!f.startsWith(path.join(__dirname,'public'))||!fs.existsSync(f))return send(res,404,{error:'Not found'});const ext=path.extname(f),types={'.html':'text/html; charset=utf-8','.css':'text/css','.js':'application/javascript'};res.writeHead(200,{'Content-Type':types[ext]||'application/octet-stream','Cache-Control':'no-store'});fs.createReadStream(f).pipe(res)}catch(e){console.error(e);send(res,500,{error:'Server error'})}});server.listen(PORT,()=>console.log(`Activity Challenge running on ${ORIGIN}`));
