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
// Additive, non-destructive migration: adds columns to an existing on-disk database without
// touching anything already in it. Safe to run on every boot.
function ensureColumn(table,column,definition){if(!db.prepare(`PRAGMA table_info(${table})`).all().some(c=>c.name===column))db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)}
ensureColumn('activities','start_time','TEXT');
ensureColumn('activities','end_time','TEXT');
ensureColumn('challenges','description','TEXT');
ensureColumn('activities','comment','TEXT');
ensureColumn('teams','image_url','TEXT');
ensureColumn('users','avatar_url','TEXT');

// --- uploaded images (avatars, team logos, description images) --------------------------
// Stored under DATA_DIR (the persistent volume), never under the app's own public/ dir, which
// is baked into the Docker image and wiped on every rebuild.
const UPLOADS_DIR=path.join(DATA,'uploads');
fs.mkdirSync(UPLOADS_DIR,{recursive:true});
const UPLOAD_MAX_BYTES=10*1024*1024;
// Never trust the client's declared mime type for what we write to disk or serve back -
// sniff real magic bytes so a mislabelled or malicious payload can't pick its own extension.
function detectImageType(buf){
  if(buf.length>=8&&buf[0]===0x89&&buf[1]===0x50&&buf[2]===0x4e&&buf[3]===0x47)return {ext:'png',mime:'image/png'};
  if(buf.length>=3&&buf[0]===0xff&&buf[1]===0xd8&&buf[2]===0xff)return {ext:'jpg',mime:'image/jpeg'};
  if(buf.length>=6&&buf.toString('ascii',0,3)==='GIF')return {ext:'gif',mime:'image/gif'};
  if(buf.length>=12&&buf.toString('ascii',0,4)==='RIFF'&&buf.toString('ascii',8,12)==='WEBP')return {ext:'webp',mime:'image/webp'};
  return null;
}

// --- rich-text sanitizer for challenge descriptions --------------------------------------
// Hand-rolled, not a battle-tested library (this app stays dependency-free), so it takes the
// simplest defensible shape: a streaming allowlist tokenizer, never a find/replace over the
// whole string. Every tag not on the allowlist is dropped (its own text content survives as
// inert escaped text, which is what neutralises e.g. <script>) and no tag, allowed or not, may
// ever carry a style or on* attribute - those simply aren't in ALLOWED_ATTRS for anything, so
// they're stripped unconditionally rather than pattern-matched and blocked. Applied once on
// every write path (POST/PATCH /api/challenges); the client renders the stored result as-is on
// the assumption that whatever is in the database already went through this. Never call this
// only client-side - the API is a public HTTP interface and a direct POST would skip it.
const RTE_ALLOWED_TAGS=new Set(['p','br','b','strong','i','em','u','ul','ol','li','a','img','h1','h2','h3','blockquote']);
const RTE_ALLOWED_ATTRS={a:['href'],img:['src','alt']};
function sanitizeHtml(html){
  if(!html)return html;
  const escapeText=s=>s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  let out='',i=0;
  const n=html.length;
  while(i<n){
    const lt=html.indexOf('<',i);
    if(lt===-1){out+=escapeText(html.slice(i));break}
    out+=escapeText(html.slice(i,lt));
    const gt=html.indexOf('>',lt);
    if(gt===-1){out+=escapeText(html.slice(lt));break}
    const tagContent=html.slice(lt+1,gt);
    i=gt+1;
    if(!tagContent||/^[!?]/.test(tagContent))continue;
    const closing=tagContent.startsWith('/');
    const rest=(closing?tagContent.slice(1):tagContent).trim();
    const tm=rest.match(/^([a-zA-Z][a-zA-Z0-9]*)/);
    if(!tm)continue;
    const tagName=tm[1].toLowerCase();
    if(!RTE_ALLOWED_TAGS.has(tagName))continue;
    if(closing){out+=`</${tagName}>`;continue}
    let attrs='';
    const allowedForTag=RTE_ALLOWED_ATTRS[tagName]||[];
    const attrRegex=/([a-zA-Z-]+)\s*=\s*"([^"]*)"|([a-zA-Z-]+)\s*=\s*'([^']*)'/g;
    let am;
    while((am=attrRegex.exec(rest))){
      const attrName=(am[1]||am[3]).toLowerCase();
      const attrVal=am[2]!==undefined?am[2]:am[4];
      if(!allowedForTag.includes(attrName))continue;
      if(attrName==='href'&&!/^(https?:|mailto:)/i.test(attrVal.trim()))continue;
      if(attrName==='src'&&!/^(https?:\/\/|\/uploads\/)/i.test(attrVal.trim()))continue;
      attrs+=` ${attrName}="${attrVal.replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}"`;
    }
    out+=`<${tagName}${attrs}>`;
  }
  return out;
}

const hash=p=>{const salt=crypto.randomBytes(16).toString('hex');return salt+':'+crypto.scryptSync(p,salt,64).toString('hex')};
const verify=(p,h)=>{const [s,k]=h.split(':');return crypto.timingSafeEqual(Buffer.from(k,'hex'),crypto.scryptSync(p,s,64))};

// --- bot/abuse precautions ---------------------------------------------------------------
// In-memory, per-IP, fixed-window counters. Resets on restart, which is an acceptable escape
// hatch for a self-hosted app this size (matches how ITCM's login lockout works).
const API_RATE_LIMIT_MAX=Number(process.env.API_RATE_LIMIT_MAX||300), API_RATE_LIMIT_WINDOW_MS=Number(process.env.API_RATE_LIMIT_WINDOW_MS||60_000);
const AUTH_RATE_LIMIT_MAX=Number(process.env.AUTH_RATE_LIMIT_MAX||20), AUTH_RATE_LIMIT_WINDOW_MS=Number(process.env.AUTH_RATE_LIMIT_WINDOW_MS||15*60_000);
const UPLOAD_RATE_LIMIT_MAX=Number(process.env.UPLOAD_RATE_LIMIT_MAX||30), UPLOAD_RATE_LIMIT_WINDOW_MS=Number(process.env.UPLOAD_RATE_LIMIT_WINDOW_MS||15*60_000);
const rateBuckets=new Map();
function hitRateLimit(key,max,windowMs){const now=Date.now(),b=rateBuckets.get(key);if(!b||b.resetAt<=now){rateBuckets.set(key,{count:1,resetAt:now+windowMs});return false}b.count++;return b.count>max}
setInterval(()=>{const now=Date.now();for(const [k,b] of rateBuckets)if(b.resetAt<=now)rateBuckets.delete(k)},10*60_000).unref();
// Prefer Cloudflare's own header (this deployment sits behind a Cloudflare Tunnel) over the
// generic, more easily spoofed X-Forwarded-For.
const clientIp=req=>req.headers['cf-connecting-ip']||(req.headers['x-forwarded-for']||'').split(',')[0].trim()||req.socket.remoteAddress||'unknown';

// reCAPTCHA is opt-in: unset RECAPTCHA_SECRET_KEY (the default) disables verification entirely,
// so local dev and automated tests work with no Google keys registered. The site key is public
// and served from /api/config so the frontend never needs it baked in at build time.
const RECAPTCHA_SITE_KEY=process.env.RECAPTCHA_SITE_KEY||'', RECAPTCHA_SECRET_KEY=process.env.RECAPTCHA_SECRET_KEY||'';
async function verifyRecaptcha(token,ip){
  if(!RECAPTCHA_SECRET_KEY)return true;
  if(!token)return false;
  try{
    const r=await fetch('https://www.google.com/recaptcha/api/siteverify',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({secret:RECAPTCHA_SECRET_KEY,response:token,remoteip:ip})});
    const j=await r.json();
    return j.success===true;
  }catch(e){console.error('reCAPTCHA verification request failed',e);return false}
}
function attemptLogin(email,password){const x=db.prepare('SELECT * FROM users WHERE email=?').get(String(email||'').toLowerCase());if(!x||!verify(password||'',x.password_hash))return null;const t=startSession(x.id);return {sessionToken:t,user:{id:x.id,email:x.email,name:x.name,role:x.role,avatarUrl:x.avatar_url}}}

// Excludes 0/O/1/I/L to avoid transcription mistakes when someone reads a code aloud or off a screen.
const CODE_ALPHABET='ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const genCode=(len=8)=>{const b=crypto.randomBytes(len);let s='';for(let i=0;i<len;i++)s+=CODE_ALPHABET[b[i]%CODE_ALPHABET.length];return s};
const isUniqueViolation=e=>/UNIQUE constraint failed/i.test(e.message||'');

function insertChallenge(name,start_date,end_date,uid,description=null){
  for(let attempt=0;attempt<10;attempt++){
    const code=genCode();
    try{
      const r=db.prepare('INSERT INTO challenges(name,start_date,end_date,created_by,invite_code,description) VALUES(?,?,?,?,?,?)').run(name,start_date,end_date,uid,code,description);
      const id=Number(r.lastInsertRowid);
      db.prepare("INSERT INTO challenge_members(challenge_id,user_id,challenge_role) VALUES(?,?,'owner')").run(id,uid);
      return {id,invite_code:code};
    }catch(e){ if(isUniqueViolation(e))continue; throw e; }
  }
  throw new Error('Could not allocate a unique invite code');
}
function insertTeam(challengeId,name,uid,imageUrl=null){
  for(let attempt=0;attempt<10;attempt++){
    const code=genCode();
    try{
      const r=db.prepare('INSERT INTO teams(challenge_id,name,created_by,invite_code,image_url) VALUES(?,?,?,?,?)').run(challengeId,name,uid,code,imageUrl);
      const id=Number(r.lastInsertRowid);
      db.prepare("INSERT INTO team_members(team_id,user_id,team_role) VALUES(?,?,'team_admin')").run(id,uid);
      return {id,invite_code:code};
    }catch(e){ if(isUniqueViolation(e))continue; throw e; }
  }
  throw new Error('Could not allocate a unique invite code');
}
// Avatars/logos only ever come from our own upload endpoint, so a valid value always looks like
// this - anything else (an external URL, a javascript: scheme, a hand-crafted API call) is
// rejected rather than silently accepted.
const UPLOAD_URL_RE=/^\/uploads\/[a-f0-9]{32}\.(png|jpg|gif|webp)$/;
function validateImageUrl(v){
  if(v===undefined)return undefined;
  if(v===null||v==='')return null;
  const s=String(v).trim();
  if(!UPLOAD_URL_RE.test(s))throw new Error('Invalid image reference');
  return s;
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

// Data retention: per the privacy policy, a challenge and everything scoped to it (teams,
// memberships, activities) is deleted 60 days after its end_date. activities.challenge_id/
// team_id have no ON DELETE CASCADE (unlike challenge_members/team_members, which do), so
// activities are deleted explicitly first, same pattern as the team-delete endpoint. Uploaded
// images (team logos, description images) referenced by a purged challenge are not garbage
// collected - a known, documented gap, not an oversight.
function purgeExpiredChallenges(){
  const expired=db.prepare("SELECT id FROM challenges WHERE date(end_date)<date('now','-60 days')").all();
  for(const {id} of expired){
    try{
      db.exec('BEGIN');
      db.prepare('DELETE FROM activities WHERE challenge_id=?').run(id);
      db.prepare('DELETE FROM challenges WHERE id=?').run(id);
      db.exec('COMMIT');
      console.log(`Purged challenge ${id}: past its 60-day post-end retention window`);
    }catch(e){db.exec('ROLLBACK');console.error('Failed to purge expired challenge',id,e)}
  }
}
purgeExpiredChallenges();
setInterval(purgeExpiredChallenges,24*60*60*1000).unref();

const send=(res,status,data,headers={})=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8',...headers});res.end(JSON.stringify(data))};
// 1MB default cap on every request body; the image upload route raises it explicitly, since a
// base64 data URL runs ~33% larger than the raw image it encodes.
// Keeps reading (and discarding, once over the cap) chunks until the stream actually ends,
// rather than throwing mid-stream and abandoning the rest on the socket - an early throw here
// used to leave an oversized request's tail undrained on a kept-alive connection, which then
// corrupted whatever request the client's next fetch() reused that same socket for.
const body=async(req,maxBytes=1e6)=>{
  let s='',tooLarge=false;
  for await(const c of req){
    if(tooLarge)continue;
    s+=c;
    if(s.length>maxBytes)tooLarge=true;
  }
  if(tooLarge)throw Error('Too large');
  return s?JSON.parse(s):{};
};
const csvEscape=v=>{const s=String(v??'');return /[",\r\n]/.test(s)?'"'+s.replace(/"/g,'""')+'"':s};
const cookies=req=>Object.fromEntries((req.headers.cookie||'').split(';').filter(Boolean).map(x=>x.trim().split('=')));
function sessionToken(req){const bearer=(req.headers.authorization||'').match(/^Bearer (.+)$/i);return bearer?.[1]||cookies(req).session||null}
function auth(req){const t=sessionToken(req);if(!t)return null;return db.prepare(`SELECT u.id,u.email,u.name,u.role,u.avatar_url FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>datetime('now')`).get(crypto.createHash('sha256').update(t).digest('hex'))||null}
const need=(res,u,roles)=>{if(!u){send(res,401,{error:'Sign in required'});return false}if(roles&&!roles.includes(u.role)){send(res,403,{error:'Not authorised'});return false}return true};
const setSessionCookie=t=>({'Set-Cookie':`session=${t}; HttpOnly; SameSite=Strict; Path=/; Max-Age=604800`});
function startSession(uid){const t=crypto.randomBytes(32).toString('hex'),th=crypto.createHash('sha256').update(t).digest('hex');db.prepare("INSERT INTO sessions VALUES(?,?,datetime('now','+7 days'))").run(th,uid);return t}

function teamAccess(uid,tid){return db.prepare('SELECT team_role FROM team_members WHERE user_id=? AND team_id=?').get(uid,tid)}
function challengeAccess(uid,cid){return db.prepare('SELECT challenge_role FROM challenge_members WHERE user_id=? AND challenge_id=?').get(uid,cid)}
// A team's own admin, the owner of its parent challenge, or a global admin may rename/delete it.
function canManageTeam(u,team){if(u.role==='global_admin')return true;if(teamAccess(u.id,team.id)?.team_role==='team_admin')return true;return challengeAccess(u.id,team.challenge_id)?.challenge_role==='owner'}
// The challenge owner or a global admin may edit challenge details.
function canManageChallenge(u,cid){if(u.role==='global_admin')return true;return challengeAccess(u.id,cid)?.challenge_role==='owner'}
// Both optional, but only together: HH:MM 24h strings, finish strictly after start. Used for
// direct user input (POST/PATCH /api/activities), where an inconsistent pair should be rejected
// outright with a clear error - the caller can just fix the form and resubmit.
const TIME_RE=/^([01]\d|2[0-3]):[0-5]\d$/;
function validateTimes(start_time,end_time){
  if(!start_time&&!end_time)return {start_time:null,end_time:null};
  if(!start_time||!end_time)throw new Error('Provide both a start and finish time, or neither');
  if(!TIME_RE.test(start_time)||!TIME_RE.test(end_time))throw new Error('Times must be in HH:MM format');
  if(end_time<=start_time)throw new Error('Finish time must be after start time');
  return {start_time,end_time};
}
// Shared by self-service PATCH /api/me and admin PATCH /api/admin/users/:id. Role is deliberately
// not handled here - only the admin route may touch it, so a self-service caller can never grant
// themselves admin.
function updateUserFields(id,{name,email,passwordHash,avatarUrl}){const sets=[],params=[];if(name!==undefined){sets.push('name=?');params.push(name)}if(email!==undefined){sets.push('email=?');params.push(email)}if(passwordHash!==undefined){sets.push('password_hash=?');params.push(passwordHash)}if(avatarUrl!==undefined){sets.push('avatar_url=?');params.push(avatarUrl)}if(!sets.length)return false;params.push(id);db.prepare(`UPDATE users SET ${sets.join(',')} WHERE id=?`).run(...params);return true}

function dashboard(uid){
  const challenges=db.prepare(`SELECT c.id,c.name,c.description,c.start_date,c.end_date,c.active,c.invite_code,cm.challenge_role FROM challenges c JOIN challenge_members cm ON cm.challenge_id=c.id WHERE cm.user_id=? ORDER BY c.start_date DESC`).all(uid);
  for(const c of challenges){
    c.role=c.challenge_role; delete c.challenge_role;
    c.teams=db.prepare(`SELECT t.id,t.name,t.invite_code,tm.team_role,(SELECT COUNT(*) FROM team_members z WHERE z.team_id=t.id) members FROM teams t JOIN team_members tm ON tm.team_id=t.id WHERE tm.user_id=? AND t.challenge_id=? ORDER BY t.name`).all(uid,c.id);
    c.myMinutes=db.prepare('SELECT COALESCE(SUM(minutes),0) m FROM activities WHERE user_id=? AND challenge_id=?').get(uid,c.id).m;
  }
  const mine=db.prepare(`SELECT a.*,t.name team_name,c.name challenge_name FROM activities a JOIN teams t ON t.id=a.team_id JOIN challenges c ON c.id=a.challenge_id WHERE a.user_id=? ORDER BY activity_date DESC,a.id DESC LIMIT 20`).all(uid);
  return {challenges,mine};
}

async function api(req,res,url){
 const ip=clientIp(req);
 if(hitRateLimit('all:'+ip,API_RATE_LIMIT_MAX,API_RATE_LIMIT_WINDOW_MS))return send(res,429,{error:'Too many requests. Please slow down and try again shortly.'});
 const u=auth(req), m=req.method;
 if(m==='GET'&&url.pathname==='/api/config')return send(res,200,{recaptchaSiteKey:RECAPTCHA_SITE_KEY||null});
 if(m==='POST'&&url.pathname==='/api/register'){
   if(hitRateLimit('register:'+ip,AUTH_RATE_LIMIT_MAX,AUTH_RATE_LIMIT_WINDOW_MS))return send(res,429,{error:'Too many registration attempts from this network. Please try again later.'});
   const b=await body(req),email=String(b.email||'').toLowerCase().trim(),name=String(b.name||'').trim();
   if(!name||!email||!b.password||String(b.password).length<8)return send(res,400,{error:'Name, email and a password of at least 8 characters are required'});
   if(!(await verifyRecaptcha(b.recaptchaToken,ip)))return send(res,400,{error:'Captcha verification failed. Please try again.'});
   try{const r=db.prepare("INSERT INTO users(email,name,password_hash,role) VALUES(?,?,?,'member')").run(email,name,hash(b.password));const uid=Number(r.lastInsertRowid),t=startSession(uid);return send(res,201,{ok:true,sessionToken:t,user:{id:uid,email,name,role:'member'}},setSessionCookie(t))}catch(e){if(isUniqueViolation(e))return send(res,409,{error:'An account with that email already exists'});throw e}
 }
 if(m==='POST'&&url.pathname==='/api/login'){
   if(hitRateLimit('login:'+ip,AUTH_RATE_LIMIT_MAX,AUTH_RATE_LIMIT_WINDOW_MS))return send(res,429,{error:'Too many sign-in attempts from this network. Please try again later.'});
   const b=await body(req);
   if(!(await verifyRecaptcha(b.recaptchaToken,ip)))return send(res,400,{error:'Captcha verification failed. Please try again.'});
   const result=attemptLogin(b.email,b.password);
   if(!result)return send(res,401,{error:'Invalid email or password'});
   return send(res,200,{ok:true,...result},setSessionCookie(result.sessionToken));
 }
 // Bearer-token login for the Android/iOS companion apps, which have no web page to render a
 // captcha widget in. Deliberately not recaptcha-gated; relies on the same per-IP rate limit
 // below plus the normal password check for abuse resistance instead.
 if(m==='POST'&&url.pathname==='/api/mobile/login'){
   if(hitRateLimit('mobilelogin:'+ip,AUTH_RATE_LIMIT_MAX,AUTH_RATE_LIMIT_WINDOW_MS))return send(res,429,{error:'Too many sign-in attempts from this network. Please try again later.'});
   const b=await body(req),result=attemptLogin(b.email,b.password);
   if(!result)return send(res,401,{error:'Invalid email or password'});
   return send(res,200,{ok:true,...result});
 }
 if(m==='POST'&&url.pathname==='/api/logout'){if(u){const t=sessionToken(req);db.prepare('DELETE FROM sessions WHERE token_hash=?').run(crypto.createHash('sha256').update(t).digest('hex'))}return send(res,200,{ok:true},{'Set-Cookie':'session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0'})}
 if(m==='GET'&&url.pathname==='/api/me')return send(res,200,{user:u});
 if(m==='PATCH'&&url.pathname==='/api/me'){
   if(!need(res,u))return;
   const b=await body(req);
   const name=b.name!==undefined?String(b.name).trim():undefined;
   if(name!==undefined&&!name)return send(res,400,{error:'Name cannot be empty'});
   const email=b.email!==undefined?String(b.email).toLowerCase().trim():undefined;
   if(email!==undefined&&!email)return send(res,400,{error:'Email cannot be empty'});
   const changingSensitive=email!==undefined||!!b.newPassword;
   if(changingSensitive){
     const current=db.prepare('SELECT password_hash FROM users WHERE id=?').get(u.id);
     if(!b.currentPassword||!verify(b.currentPassword,current.password_hash))return send(res,400,{error:'Current password is required and must be correct to change your email or password'});
   }
   let passwordHash;
   if(b.newPassword){if(String(b.newPassword).length<8)return send(res,400,{error:'New password must be at least 8 characters'});passwordHash=hash(b.newPassword)}
   let avatarUrl;
   try{avatarUrl=validateImageUrl(b.avatarUrl)}catch(e){return send(res,400,{error:e.message})}
   try{
     if(!updateUserFields(u.id,{name,email,passwordHash,avatarUrl}))return send(res,400,{error:'Nothing to update'});
   }catch(e){if(isUniqueViolation(e))return send(res,409,{error:'An account with that email already exists'});throw e}
   if(passwordHash){const t=sessionToken(req);db.prepare('DELETE FROM sessions WHERE user_id=? AND token_hash!=?').run(u.id,crypto.createHash('sha256').update(t).digest('hex'))}
   return send(res,200,{ok:true,user:db.prepare('SELECT id,email,name,role,avatar_url FROM users WHERE id=?').get(u.id)});
 }
 if(m==='POST'&&url.pathname==='/api/uploads'){
   if(hitRateLimit('upload:'+ip,UPLOAD_RATE_LIMIT_MAX,UPLOAD_RATE_LIMIT_WINDOW_MS))return send(res,429,{error:'Too many uploads. Please slow down.'});
   if(!need(res,u))return;
   let b;
   try{b=await body(req,Math.ceil(UPLOAD_MAX_BYTES*4/3)+2048)}catch(e){return send(res,413,{error:'Image is too large (max 10MB).'})}
   const dm=String(b.dataUrl||'').match(/^data:image\/[a-z]+;base64,(.+)$/i);
   if(!dm)return send(res,400,{error:'A valid image data URL is required'});
   const buf=Buffer.from(dm[1],'base64');
   if(buf.length>UPLOAD_MAX_BYTES)return send(res,413,{error:'Image is too large (max 10MB).'});
   const detected=detectImageType(buf);
   if(!detected)return send(res,400,{error:'Unrecognised image format. Use PNG, JPEG, GIF or WEBP.'});
   const filename=`${crypto.randomBytes(16).toString('hex')}.${detected.ext}`;
   fs.writeFileSync(path.join(UPLOADS_DIR,filename),buf);
   return send(res,201,{url:`/uploads/${filename}`});
 }
 if(m==='GET'&&url.pathname==='/api/dashboard'){if(!need(res,u))return;return send(res,200,{user:u,...dashboard(u.id)})}
 if(m==='GET'&&url.pathname==='/api/mobile/bootstrap'){if(!need(res,u))return;return send(res,200,{user:u,...dashboard(u.id),health:{healthConnect:{platform:'Android',mode:'native-companion-required'},healthKit:{platform:'iOS',mode:'native-companion-required'},acceptedRecord:'exercise session duration',uploadEndpoint:'/api/health/import'}})}

 if(m==='POST'&&url.pathname==='/api/challenges'){if(!need(res,u))return;const b=await body(req);if(!b.name||!b.start_date||!b.end_date)return send(res,400,{error:'name, start_date and end_date are required'});const description=b.description!==undefined?(sanitizeHtml(String(b.description).trim())||null):null;const {id,invite_code}=insertChallenge(String(b.name).trim(),b.start_date,b.end_date,u.id,description);return send(res,201,{id,invite_code})}
 if(m==='GET'&&url.pathname.match(/^\/api\/challenges\/\d+$/)){if(!need(res,u))return;const cid=Number(url.pathname.split('/')[3]),ca=challengeAccess(u.id,cid);if(!ca)return send(res,403,{error:'You need an invite code to view this challenge'});const c=db.prepare('SELECT id,name,description,start_date,end_date,active,invite_code,created_by FROM challenges WHERE id=?').get(cid);const teams=db.prepare(`SELECT t.id,t.name,t.image_url,t.invite_code,(SELECT COUNT(*) FROM team_members z WHERE z.team_id=t.id) members,tm.team_role FROM teams t LEFT JOIN team_members tm ON tm.team_id=t.id AND tm.user_id=? WHERE t.challenge_id=? ORDER BY t.name`).all(u.id,cid).map(t=>{const mine=t.team_role!=null,canManage=u.role==='global_admin'||t.team_role==='team_admin'||ca.challenge_role==='owner';return {id:t.id,name:t.name,image_url:t.image_url,members:t.members,mine,canManage,invite_code:(mine||canManage)?t.invite_code:undefined}});return send(res,200,{...c,role:ca.challenge_role,canManage:canManageChallenge(u,cid),teams})}
 if(m==='PATCH'&&url.pathname.match(/^\/api\/challenges\/\d+$/)){if(!need(res,u))return;const cid=Number(url.pathname.split('/')[3]),challenge=db.prepare('SELECT * FROM challenges WHERE id=?').get(cid);if(!challenge)return send(res,404,{error:'Challenge not found'});if(!canManageChallenge(u,cid))return send(res,403,{error:'Only the challenge owner can edit this challenge'});const b=await body(req),name=b.name!==undefined?String(b.name).trim():challenge.name,start_date=b.start_date!==undefined?b.start_date:challenge.start_date,end_date=b.end_date!==undefined?b.end_date:challenge.end_date,description=b.description!==undefined?(sanitizeHtml(String(b.description).trim())||null):challenge.description;if(!name||!start_date||!end_date)return send(res,400,{error:'name, start_date and end_date are required'});db.prepare('UPDATE challenges SET name=?,start_date=?,end_date=?,description=? WHERE id=?').run(name,start_date,end_date,description,cid);return send(res,200,{ok:true})}
 if(m==='GET'&&url.pathname.match(/^\/api\/challenges\/\d+\/members$/)){if(!need(res,u))return;const cid=Number(url.pathname.split('/')[3]);if(!db.prepare('SELECT id FROM challenges WHERE id=?').get(cid))return send(res,404,{error:'Challenge not found'});if(!canManageChallenge(u,cid))return send(res,403,{error:'Only a challenge owner can view this'});const members=db.prepare('SELECT us.id,us.name,us.email,cm.challenge_role FROM challenge_members cm JOIN users us ON us.id=cm.user_id WHERE cm.challenge_id=? ORDER BY cm.challenge_role,us.name').all(cid);return send(res,200,{members})}
 if(m==='POST'&&url.pathname.match(/^\/api\/challenges\/\d+\/owners$/)){if(!need(res,u))return;const cid=Number(url.pathname.split('/')[3]);if(!db.prepare('SELECT id FROM challenges WHERE id=?').get(cid))return send(res,404,{error:'Challenge not found'});if(!canManageChallenge(u,cid))return send(res,403,{error:'Only a challenge owner can add another owner'});const b=await body(req),email=String(b.email||'').toLowerCase().trim();if(!email)return send(res,400,{error:'Email is required'});const found=db.prepare('SELECT id,name,email FROM users WHERE email=?').get(email);if(!found)return send(res,404,{error:'No account found for that email. Ask them to register first.'});const existing=db.prepare('SELECT 1 FROM challenge_members WHERE challenge_id=? AND user_id=?').get(cid,found.id);if(existing)db.prepare("UPDATE challenge_members SET challenge_role='owner' WHERE challenge_id=? AND user_id=?").run(cid,found.id);else db.prepare("INSERT INTO challenge_members(challenge_id,user_id,challenge_role) VALUES(?,?,'owner')").run(cid,found.id);return send(res,201,{ok:true,user:found})}
 if(m==='GET'&&url.pathname.match(/^\/api\/challenges\/\d+\/leaderboard\/export$/)){if(!need(res,u))return;const cid=Number(url.pathname.split('/')[3]),challenge=db.prepare('SELECT name FROM challenges WHERE id=?').get(cid);if(!challenge)return send(res,404,{error:'Challenge not found'});if(!canManageChallenge(u,cid))return send(res,403,{error:'Only the challenge owner or a global admin can export the leaderboard'});const type=url.searchParams.get('type')==='users'?'users':'teams';let header,rows;if(type==='teams'){header=['Rank','Team','Minutes'];rows=db.prepare(`SELECT t.name,COALESCE(SUM(a.minutes),0) minutes FROM teams t LEFT JOIN activities a ON a.team_id=t.id WHERE t.challenge_id=? GROUP BY t.id ORDER BY minutes DESC,t.name`).all(cid).map((r,i)=>[i+1,r.name,r.minutes])}else{header=['Rank','Name','Email','Minutes'];rows=db.prepare(`SELECT us.name,us.email,COALESCE(SUM(a.minutes),0) minutes FROM challenge_members cmem JOIN users us ON us.id=cmem.user_id LEFT JOIN activities a ON a.user_id=us.id AND a.challenge_id=cmem.challenge_id WHERE cmem.challenge_id=? GROUP BY us.id ORDER BY minutes DESC,us.name`).all(cid).map((r,i)=>[i+1,r.name,r.email,r.minutes])}const csv=[header,...rows].map(r=>r.map(csvEscape).join(',')).join('\r\n'),safeName=challenge.name.replace(/[^a-z0-9]+/gi,'-').toLowerCase()||'challenge';res.writeHead(200,{'Content-Type':'text/csv; charset=utf-8','Content-Disposition':`attachment; filename="${safeName}-${type}.csv"`});return res.end(csv)}
 if(m==='GET'&&url.pathname.match(/^\/api\/challenges\/\d+\/leaderboard$/)){if(!need(res,u))return;const cid=Number(url.pathname.split('/')[3]);if(!challengeAccess(u.id,cid))return send(res,403,{error:'You need an invite code to view this challenge'});const teams=db.prepare(`SELECT t.id,t.name,t.image_url,COALESCE(SUM(a.minutes),0) minutes FROM teams t LEFT JOIN activities a ON a.team_id=t.id WHERE t.challenge_id=? GROUP BY t.id ORDER BY minutes DESC,t.name`).all(cid);const users=db.prepare(`SELECT us.id,us.name,us.avatar_url,COALESCE(SUM(a.minutes),0) minutes FROM challenge_members cmem JOIN users us ON us.id=cmem.user_id LEFT JOIN activities a ON a.user_id=us.id AND a.challenge_id=cmem.challenge_id WHERE cmem.challenge_id=? GROUP BY us.id ORDER BY minutes DESC,us.name`).all(cid);return send(res,200,{teams,users})}

 if(m==='POST'&&url.pathname==='/api/join'){if(!need(res,u))return;const b=await body(req),code=String(b.code||'').trim().toUpperCase();if(!code)return send(res,400,{error:'Invite code required'});const challenge=db.prepare('SELECT * FROM challenges WHERE invite_code=?').get(code);if(challenge){db.prepare("INSERT OR IGNORE INTO challenge_members(challenge_id,user_id,challenge_role) VALUES(?,?,'member')").run(challenge.id,u.id);return send(res,200,{ok:true,type:'challenge',challengeId:challenge.id,name:challenge.name})}const team=db.prepare('SELECT * FROM teams WHERE invite_code=?').get(code);if(team){db.prepare("INSERT OR IGNORE INTO challenge_members(challenge_id,user_id,challenge_role) VALUES(?,?,'member')").run(team.challenge_id,u.id);db.prepare("INSERT OR IGNORE INTO team_members(team_id,user_id,team_role) VALUES(?,?,'member')").run(team.id,u.id);return send(res,200,{ok:true,type:'team',challengeId:team.challenge_id,teamId:team.id,name:team.name})}return send(res,400,{error:'That invite code was not recognised'})}

 if(m==='POST'&&url.pathname==='/api/teams'){if(!need(res,u))return;const b=await body(req),cid=Number(b.challenge_id);if(!b.name||!cid)return send(res,400,{error:'challenge_id and name are required'});if(!challengeAccess(u.id,cid))return send(res,403,{error:'Join the challenge before creating a team in it'});let imageUrl;try{imageUrl=validateImageUrl(b.image_url)}catch(e){return send(res,400,{error:e.message})}const {id,invite_code}=insertTeam(cid,String(b.name).trim(),u.id,imageUrl||null);return send(res,201,{id,invite_code})}
 if(m==='POST'&&url.pathname.match(/^\/api\/teams\/\d+\/join$/)){if(!need(res,u))return;const tid=Number(url.pathname.split('/')[3]),team=db.prepare('SELECT * FROM teams WHERE id=?').get(tid);if(!team)return send(res,404,{error:'Team not found'});if(!challengeAccess(u.id,team.challenge_id))return send(res,403,{error:'Join the challenge before joining one of its teams'});db.prepare("INSERT OR IGNORE INTO team_members(team_id,user_id,team_role) VALUES(?,?,'member')").run(tid,u.id);return send(res,200,{ok:true})}
 if(m==='PATCH'&&url.pathname.match(/^\/api\/teams\/\d+$/)){if(!need(res,u))return;const tid=Number(url.pathname.split('/')[3]),team=db.prepare('SELECT * FROM teams WHERE id=?').get(tid);if(!team)return send(res,404,{error:'Team not found'});if(!canManageTeam(u,team))return send(res,403,{error:'Only a team admin or the challenge owner can rename this team'});const b=await body(req),name=String(b.name||'').trim();if(!name)return send(res,400,{error:'Name is required'});let imageUrl;try{imageUrl=validateImageUrl(b.image_url)}catch(e){return send(res,400,{error:e.message})}if(imageUrl!==undefined)db.prepare('UPDATE teams SET name=?,image_url=? WHERE id=?').run(name,imageUrl,tid);else db.prepare('UPDATE teams SET name=? WHERE id=?').run(name,tid);return send(res,200,{ok:true})}
 if(m==='DELETE'&&url.pathname.match(/^\/api\/teams\/\d+$/)){if(!need(res,u))return;const tid=Number(url.pathname.split('/')[3]),team=db.prepare('SELECT * FROM teams WHERE id=?').get(tid);if(!team)return send(res,404,{error:'Team not found'});if(!canManageTeam(u,team))return send(res,403,{error:'Only a team admin or the challenge owner can delete this team'});try{db.exec('BEGIN');db.prepare('DELETE FROM activities WHERE team_id=?').run(tid);db.prepare('DELETE FROM teams WHERE id=?').run(tid);db.exec('COMMIT')}catch(e){db.exec('ROLLBACK');throw e}return send(res,200,{ok:true})}
 if(m==='GET'&&url.pathname.match(/^\/api\/teams\/\d+\/members$/)){if(!need(res,u))return;const tid=Number(url.pathname.split('/')[3]),team=db.prepare('SELECT * FROM teams WHERE id=?').get(tid);if(!team)return send(res,404,{error:'Team not found'});const manage=canManageTeam(u,team);if(!teamAccess(u.id,tid)&&!manage)return send(res,403,{error:'You need to be in this team to view its members'});const members=db.prepare('SELECT u.id,u.name,u.email,tm.team_role FROM team_members tm JOIN users u ON u.id=tm.user_id WHERE tm.team_id=? ORDER BY u.name').all(tid);return send(res,200,{members,canManage:manage})}
 if(m==='POST'&&url.pathname.match(/^\/api\/teams\/\d+\/members$/)){if(!need(res,u))return;const tid=Number(url.pathname.split('/')[3]),team=db.prepare('SELECT * FROM teams WHERE id=?').get(tid);if(!team)return send(res,404,{error:'Team not found'});if(!canManageTeam(u,team))return send(res,403,{error:'Only a team admin or the challenge owner can add members'});const b=await body(req),email=String(b.email||'').toLowerCase().trim();if(!email)return send(res,400,{error:'Email is required'});const found=db.prepare('SELECT id,name,email FROM users WHERE email=?').get(email);if(!found)return send(res,404,{error:'No account found for that email. Ask them to register first, or share the invite code instead.'});db.prepare("INSERT OR IGNORE INTO challenge_members(challenge_id,user_id,challenge_role) VALUES(?,?,'member')").run(team.challenge_id,found.id);db.prepare("INSERT OR IGNORE INTO team_members(team_id,user_id,team_role) VALUES(?,?,'member')").run(tid,found.id);return send(res,201,{ok:true,user:found})}
 if(m==='DELETE'&&url.pathname.match(/^\/api\/teams\/\d+\/members\/\d+$/)){if(!need(res,u))return;const parts=url.pathname.split('/'),tid=Number(parts[3]),targetId=Number(parts[5]),team=db.prepare('SELECT * FROM teams WHERE id=?').get(tid);if(!team)return send(res,404,{error:'Team not found'});if(!canManageTeam(u,team))return send(res,403,{error:'Only a team admin or the challenge owner can remove members'});db.prepare('DELETE FROM team_members WHERE team_id=? AND user_id=?').run(tid,targetId);return send(res,200,{ok:true})}
 if(m==='POST'&&url.pathname.match(/^\/api\/teams\/\d+\/invite$/)){if(!need(res,u))return;const tid=Number(url.pathname.split('/')[3]),ta=teamAccess(u.id,tid);if(u.role!=='global_admin'&&ta?.team_role!=='team_admin')return send(res,403,{error:'Team admin required'});const b=await body(req),token=crypto.randomBytes(24).toString('hex'),exp=new Date(Date.now()+7*864e5).toISOString();db.prepare('INSERT INTO invites(team_id,email,token,team_role,expires_at,created_by) VALUES(?,?,?,?,?,?)').run(tid,String(b.email).toLowerCase(),token,b.team_role||'member',exp,u.id);return send(res,201,{inviteUrl:`${ORIGIN}/?invite=${token}`,expiresAt:exp})}
 if(m==='POST'&&url.pathname==='/api/invites/accept'){if(!need(res,u))return;const b=await body(req),inv=db.prepare("SELECT * FROM invites WHERE token=? AND accepted_at IS NULL AND expires_at>datetime('now')").get(b.token);if(!inv)return send(res,400,{error:'Invite invalid or expired'});if(inv.email!==u.email)return send(res,403,{error:'This invite was issued to another email address'});const team=db.prepare('SELECT challenge_id FROM teams WHERE id=?').get(inv.team_id);db.prepare("INSERT OR IGNORE INTO challenge_members(challenge_id,user_id,challenge_role) VALUES(?,?,'member')").run(team.challenge_id,u.id);db.prepare('INSERT OR REPLACE INTO team_members(team_id,user_id,team_role) VALUES(?,?,?)').run(inv.team_id,u.id,inv.team_role);db.prepare("UPDATE invites SET accepted_at=datetime('now') WHERE id=?").run(inv.id);return send(res,200,{ok:true,challengeId:team.challenge_id,teamId:inv.team_id})}

 if(m==='POST'&&url.pathname==='/api/activities'){if(!need(res,u))return;const b=await body(req),teamId=Number(b.team_id),challengeId=Number(b.challenge_id),team=db.prepare('SELECT challenge_id FROM teams WHERE id=?').get(teamId);if(!team||team.challenge_id!==challengeId)return send(res,400,{error:'That team is not part of this challenge'});if(!teamAccess(u.id,teamId))return send(res,403,{error:'You are not in this team'});let times;try{times=validateTimes(b.start_time,b.end_time)}catch(e){return send(res,400,{error:e.message})}const comment=b.comment!==undefined?(String(b.comment).trim().slice(0,500)||null):null;try{db.prepare('INSERT INTO activities(user_id,team_id,challenge_id,activity_type,minutes,activity_date,source,source_ref,start_time,end_time,comment) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(u.id,teamId,challengeId,b.activity_type,Number(b.minutes),b.activity_date,b.source||'manual',b.source_ref||null,times.start_time,times.end_time,comment);return send(res,201,{ok:true})}catch(e){return send(res,400,{error:'Invalid or duplicate activity'})}}
 // Only the person who logged an entry may edit or delete it - team_id/challenge_id are
 // intentionally not editable here, so "fixing" an entry never re-attributes it elsewhere.
 if(m==='PATCH'&&url.pathname.match(/^\/api\/activities\/\d+$/)){
   if(!need(res,u))return;
   const id=Number(url.pathname.split('/')[3]),existing=db.prepare('SELECT * FROM activities WHERE id=?').get(id);
   if(!existing)return send(res,404,{error:'Activity not found'});
   if(existing.user_id!==u.id)return send(res,403,{error:'You can only edit your own activity'});
   const b=await body(req);
   const activity_type=b.activity_type!==undefined?String(b.activity_type).trim():existing.activity_type;
   const minutes=b.minutes!==undefined?Number(b.minutes):existing.minutes;
   const activity_date=b.activity_date!==undefined?b.activity_date:existing.activity_date;
   const start_time=b.start_time!==undefined?b.start_time:existing.start_time;
   const end_time=b.end_time!==undefined?b.end_time:existing.end_time;
   const comment=b.comment!==undefined?(String(b.comment).trim().slice(0,500)||null):existing.comment;
   if(!activity_type||!Number.isFinite(minutes)||minutes<=0||!activity_date)return send(res,400,{error:'Invalid activity fields'});
   let times;
   try{times=validateTimes(start_time,end_time)}catch(e){return send(res,400,{error:e.message})}
   db.prepare('UPDATE activities SET activity_type=?,minutes=?,activity_date=?,start_time=?,end_time=?,comment=? WHERE id=?').run(activity_type,minutes,activity_date,times.start_time,times.end_time,comment,id);
   return send(res,200,{ok:true});
 }
 if(m==='DELETE'&&url.pathname.match(/^\/api\/activities\/\d+$/)){
   if(!need(res,u))return;
   const id=Number(url.pathname.split('/')[3]),existing=db.prepare('SELECT * FROM activities WHERE id=?').get(id);
   if(!existing)return send(res,404,{error:'Activity not found'});
   if(existing.user_id!==u.id)return send(res,403,{error:'You can only delete your own activity'});
   db.prepare('DELETE FROM activities WHERE id=?').run(id);
   return send(res,200,{ok:true});
 }

 if(m==='GET'&&url.pathname==='/api/admin/users'){if(!need(res,u,['global_admin']))return;return send(res,200,{users:db.prepare('SELECT id,email,name,role,created_at FROM users ORDER BY name').all()})}
 if(m==='POST'&&url.pathname==='/api/admin/users'){if(!need(res,u,['global_admin']))return;const b=await body(req);try{const r=db.prepare('INSERT INTO users(email,name,password_hash,role) VALUES(?,?,?,?)').run(String(b.email).toLowerCase(),b.name,hash(b.password),b.role||'member');return send(res,201,{id:Number(r.lastInsertRowid)})}catch(e){return send(res,400,{error:'Email already exists or fields are invalid'})}}
 if(m==='PATCH'&&url.pathname.match(/^\/api\/admin\/users\/\d+$/)){
   if(!need(res,u,['global_admin']))return;
   const id=Number(url.pathname.split('/').pop()),b=await body(req);
   if(!db.prepare('SELECT id FROM users WHERE id=?').get(id))return send(res,404,{error:'User not found'});
   const name=b.name!==undefined?String(b.name).trim():undefined;
   if(name!==undefined&&!name)return send(res,400,{error:'Name cannot be empty'});
   const email=b.email!==undefined?String(b.email).toLowerCase().trim():undefined;
   if(email!==undefined&&!email)return send(res,400,{error:'Email cannot be empty'});
   let passwordHash;
   if(b.password){if(String(b.password).length<8)return send(res,400,{error:'Password must be at least 8 characters'});passwordHash=hash(b.password)}
   try{
     updateUserFields(id,{name,email,passwordHash});
     if(b.role!==undefined)db.prepare('UPDATE users SET role=? WHERE id=?').run(b.role,id);
   }catch(e){if(isUniqueViolation(e))return send(res,409,{error:'An account with that email already exists'});throw e}
   if(passwordHash)db.prepare('DELETE FROM sessions WHERE user_id=?').run(id);
   return send(res,200,{ok:true})
 }

 if(m==='GET'&&url.pathname==='/api/health/status'){if(!need(res,u))return;return send(res,200,{healthConnect:{platform:'Android',mode:'native-companion-required'},healthKit:{platform:'iOS',mode:'native-companion-required'},acceptedRecord:'exercise session duration',uploadEndpoint:'/api/health/import'})}
 if(m==='POST'&&url.pathname==='/api/health/import'){if(!need(res,u))return;const b=await body(req);if(!Array.isArray(b.records))return send(res,400,{error:'records array required'});if(!['health_connect','health_kit'].includes(b.source))return send(res,400,{error:'source must be health_connect or health_kit'});let added=0,skipped=0;for(const x of b.records){const teamId=Number(x.team_id),challengeId=Number(x.challenge_id),minutes=Number(x.minutes),team=db.prepare('SELECT challenge_id FROM teams WHERE id=?').get(teamId);if(!team||team.challenge_id!==challengeId||!teamAccess(u.id,teamId)||!Number.isInteger(minutes)||minutes<=0||!x.activity_date||!x.source_ref){skipped++;continue}
   // Times here are best-effort device data, not direct user input: an inconsistent or
   // midnight-crossing pair just means "no times", not "reject the whole synced session".
   let times={start_time:null,end_time:null};try{times=validateTimes(x.start_time,x.end_time)}catch(e){}
   try{db.prepare('INSERT INTO activities(user_id,team_id,challenge_id,activity_type,minutes,activity_date,source,source_ref,start_time,end_time) VALUES(?,?,?,?,?,?,?,?,?,?)').run(u.id,teamId,challengeId,x.activity_type||'Synced activity',minutes,x.activity_date,b.source,x.source_ref,times.start_time,times.end_time);added++}catch(e){skipped++}}return send(res,200,{added,skipped})}
 return send(res,404,{error:'Not found'});
}
const UPLOAD_MIME={png:'image/png',jpg:'image/jpeg',gif:'image/gif',webp:'image/webp'};
const server=http.createServer(async(req,res)=>{try{const url=new URL(req.url,ORIGIN);if(url.pathname.startsWith('/api/'))return await api(req,res,url);
 if(url.pathname.startsWith('/uploads/')){
   const rel=path.normalize(url.pathname.slice('/uploads/'.length)).replace(/^\.\.(\/|\\|$)/,'');
   const f=path.join(UPLOADS_DIR,rel);
   if(!f.startsWith(UPLOADS_DIR)||!fs.existsSync(f))return send(res,404,{error:'Not found'});
   const ext=path.extname(f).slice(1).toLowerCase();
   res.writeHead(200,{'Content-Type':UPLOAD_MIME[ext]||'application/octet-stream','Cache-Control':'public, max-age=31536000, immutable','X-Content-Type-Options':'nosniff'});
   return fs.createReadStream(f).pipe(res);
 }
 let p=url.pathname==='/'?'index.html':url.pathname.slice(1);p=path.normalize(p).replace(/^\.\.(\/|\\|$)/,'');const f=path.join(__dirname,'public',p);if(!f.startsWith(path.join(__dirname,'public'))||!fs.existsSync(f))return send(res,404,{error:'Not found'});const ext=path.extname(f),types={'.html':'text/html; charset=utf-8','.css':'text/css','.js':'application/javascript','.svg':'image/svg+xml'};res.writeHead(200,{'Content-Type':types[ext]||'application/octet-stream','Cache-Control':'no-store'});fs.createReadStream(f).pipe(res)}catch(e){console.error(e);send(res,500,{error:'Server error'})}});// Node's default keepAliveTimeout is 5s, which races a client that reuses a pooled keep-alive
// connection right as the server decides to close it - the client's write lands on a socket the
// server is already tearing down, seen as a bare ECONNRESET with no HTTP response at all.
// headersTimeout must exceed keepAliveTimeout or Node logs a warning and clamps it back down.
server.keepAliveTimeout=65_000;
server.headersTimeout=66_000;
server.listen(PORT,()=>console.log(`Activity Challenge running on ${ORIGIN}`));
