'use strict';
const http=require('node:http'), fs=require('node:fs'), path=require('node:path'), crypto=require('node:crypto');
const {DatabaseSync}=require('node:sqlite');
const PORT=Number(process.env.PORT||3000), DATA=process.env.DATA_DIR||'.', ORIGIN=process.env.APP_ORIGIN||`http://localhost:${PORT}`;
fs.mkdirSync(DATA,{recursive:true}); const db=new DatabaseSync(path.join(DATA,'activity.sqlite'));
db.exec(`PRAGMA foreign_keys=ON;PRAGMA journal_mode=WAL;PRAGMA busy_timeout=5000;
CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY,email TEXT UNIQUE NOT NULL,name TEXT NOT NULL,password_hash TEXT NOT NULL,role TEXT NOT NULL DEFAULT 'member',created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS sessions(token_hash TEXT PRIMARY KEY,user_id INTEGER NOT NULL,expires_at TEXT NOT NULL,FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE);
CREATE TABLE IF NOT EXISTS challenges(id INTEGER PRIMARY KEY,name TEXT NOT NULL,start_date TEXT NOT NULL,end_date TEXT NOT NULL,created_by INTEGER NOT NULL,invite_code TEXT UNIQUE NOT NULL,active INTEGER NOT NULL DEFAULT 1,created_at TEXT DEFAULT CURRENT_TIMESTAMP,FOREIGN KEY(created_by) REFERENCES users(id));
CREATE TABLE IF NOT EXISTS challenge_members(challenge_id INTEGER,user_id INTEGER,challenge_role TEXT NOT NULL DEFAULT 'member',joined_at TEXT DEFAULT CURRENT_TIMESTAMP,PRIMARY KEY(challenge_id,user_id),FOREIGN KEY(challenge_id) REFERENCES challenges(id) ON DELETE CASCADE,FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE);
CREATE TABLE IF NOT EXISTS teams(id INTEGER PRIMARY KEY,challenge_id INTEGER NOT NULL,name TEXT NOT NULL,created_by INTEGER NOT NULL,invite_code TEXT UNIQUE NOT NULL,created_at TEXT DEFAULT CURRENT_TIMESTAMP,FOREIGN KEY(challenge_id) REFERENCES challenges(id) ON DELETE CASCADE,FOREIGN KEY(created_by) REFERENCES users(id));
CREATE TABLE IF NOT EXISTS team_members(team_id INTEGER,user_id INTEGER,team_role TEXT NOT NULL DEFAULT 'member',PRIMARY KEY(team_id,user_id),FOREIGN KEY(team_id) REFERENCES teams(id) ON DELETE CASCADE,FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE);
CREATE TABLE IF NOT EXISTS invites(id INTEGER PRIMARY KEY,team_id INTEGER NOT NULL,email TEXT NOT NULL,token TEXT UNIQUE NOT NULL,team_role TEXT NOT NULL DEFAULT 'member',expires_at TEXT NOT NULL,accepted_at TEXT,created_by INTEGER NOT NULL,FOREIGN KEY(team_id) REFERENCES teams(id) ON DELETE CASCADE);
CREATE TABLE IF NOT EXISTS activities(id INTEGER PRIMARY KEY,user_id INTEGER NOT NULL,team_id INTEGER,challenge_id INTEGER NOT NULL,activity_type TEXT NOT NULL,minutes INTEGER CHECK(minutes>0),activity_date TEXT NOT NULL,source TEXT NOT NULL DEFAULT 'manual',source_ref TEXT,created_at TEXT DEFAULT CURRENT_TIMESTAMP,UNIQUE(user_id,source,source_ref,challenge_id),FOREIGN KEY(user_id) REFERENCES users(id),FOREIGN KEY(team_id) REFERENCES teams(id),FOREIGN KEY(challenge_id) REFERENCES challenges(id));
-- A GPS route, stored once however many challenges its workout was logged into, and only ever
-- shown to the person it belongs to. Keyed like the device record it came from.
CREATE TABLE IF NOT EXISTS routes(id INTEGER PRIMARY KEY,user_id INTEGER NOT NULL,source TEXT NOT NULL,source_ref TEXT NOT NULL,points TEXT NOT NULL,point_count INTEGER NOT NULL,created_at TEXT DEFAULT CURRENT_TIMESTAMP,UNIQUE(user_id,source,source_ref),FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE);`);
// Additive, non-destructive migration: adds columns to an existing on-disk database without
// touching anything already in it. Safe to run on every boot.
function ensureColumn(table,column,definition){if(!db.prepare(`PRAGMA table_info(${table})`).all().some(c=>c.name===column))db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)}
ensureColumn('activities','start_time','TEXT');
ensureColumn('activities','end_time','TEXT');
ensureColumn('challenges','description','TEXT');
ensureColumn('activities','comment','TEXT');
ensureColumn('teams','image_url','TEXT');
ensureColumn('users','avatar_url','TEXT');
// Profiles: an optional short bio, and how much people who share a challenge with you can see.
//   private - name and photo only; summary - plus your total and rank in each shared challenge
//   (the default); full - plus your recent activity in those challenges. Leaderboard totals are
//   visible to challenge members whatever this says, and routes are never shared at any level.
ensureColumn('users','bio','TEXT');
ensureColumn('users','profile_sharing',"TEXT NOT NULL DEFAULT 'summary'");
// Set when an admin deactivates the account: it can't sign in, but its activity still counts.
ensureColumn('users','deactivated_at','TEXT');
// Apple Shortcuts sync: a personal key, stored only as a hash, lets a shortcut on an iPhone send a day's
// totals from Apple Health without signing in. Making a new key replaces the old one.
ensureColumn('users','sync_key_hash','TEXT');
ensureColumn('users','sync_key_created_at','TEXT');
const sha256hex=v=>crypto.createHash('sha256').update(String(v)).digest('hex');
// Virtual journeys: a challenge whose teams or people travel a route on a map (London to Edinburgh...)
// by the distance (or steps) they log. kind is standard or journey; journey_mode is foot or cycling;
// route_shape is roads or straight; route_from/route_to are {name,lat,lon}; route is the simplified
// line as [[lat,lon],...] and route_m its real length in metres.
ensureColumn('challenges','kind',"TEXT NOT NULL DEFAULT 'standard'");
ensureColumn('challenges','journey_mode','TEXT');
ensureColumn('challenges','route_shape','TEXT');
ensureColumn('challenges','route_from','TEXT');
ensureColumn('challenges','route_to','TEXT');
ensureColumn('challenges','route','TEXT');
ensureColumn('challenges','route_m','REAL');
// Optional stops on the way, in order: [{name,lat,lon,at_m}], at_m being how far along the route each is.
ensureColumn('challenges','route_via','TEXT');
// What the Apple Shortcut has sent for each day, kept per figure so that sending one figure (say,
// cycling distance) never wipes another; the day's challenge entries are worked out from this.
db.exec(`CREATE TABLE IF NOT EXISTS shortcut_days(user_id INTEGER NOT NULL,day TEXT NOT NULL,steps INTEGER,minutes INTEGER,walk_m REAL,cycle_m REAL,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,PRIMARY KEY(user_id,day),FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE)`);
// Help & support: bug reports, feature requests and questions, as tickets with a conversation.
// owner_seen_at / admin_seen_at against last_reply_at / last_user_reply_at drive the "new reply"
// badges on each side; internal comments are admin-only notes the reporter never sees.
db.exec(`CREATE TABLE IF NOT EXISTS tickets(id INTEGER PRIMARY KEY,user_id INTEGER NOT NULL,type TEXT NOT NULL,title TEXT NOT NULL,description TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'new',resolution TEXT,image_url TEXT,client_info TEXT,created_at TEXT DEFAULT CURRENT_TIMESTAMP,updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  last_reply_at TEXT,last_user_reply_at TEXT DEFAULT CURRENT_TIMESTAMP,owner_seen_at TEXT DEFAULT CURRENT_TIMESTAMP,admin_seen_at TEXT,
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE);
CREATE TABLE IF NOT EXISTS ticket_comments(id INTEGER PRIMARY KEY,ticket_id INTEGER NOT NULL,user_id INTEGER NOT NULL,body TEXT NOT NULL,internal INTEGER NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,FOREIGN KEY(ticket_id) REFERENCES tickets(id) ON DELETE CASCADE,FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE);`);
// Following: you can follow anyone whose profile you can see (a challenge-mate). It carries on if you
// stop sharing a challenge, but their profile then stays hidden as before.
db.exec(`CREATE TABLE IF NOT EXISTS follows(follower_id INTEGER NOT NULL,followee_id INTEGER NOT NULL,created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(follower_id,followee_id),FOREIGN KEY(follower_id) REFERENCES users(id) ON DELETE CASCADE,FOREIGN KEY(followee_id) REFERENCES users(id) ON DELETE CASCADE);
CREATE INDEX IF NOT EXISTS follows_followee ON follows(followee_id);`);
// A challenge measures active minutes (the original behaviour, and the default for every
// existing challenge), distance, or steps. Distance is stored on activities in metres whatever the
// challenge's display unit, so changing a challenge between miles and km never rewrites history.
ensureColumn('challenges','metric',"TEXT NOT NULL DEFAULT 'minutes'");
ensureColumn('challenges','distance_unit',"TEXT NOT NULL DEFAULT 'mi'");
ensureColumn('activities','distance_m','REAL');
// Who takes part: teams (the original model) or individuals only, where activity has no team.
ensureColumn('challenges','participation',"TEXT NOT NULL DEFAULT 'teams'");
ensureColumn('activities','route_id','INTEGER');
// The activities table has been rebuilt as the model grew, copying every row and column across
// unchanged each time (SQLite cannot alter constraints in place):
//  - minutes and team_id were NOT NULL when every challenge measured time in teams; a distance
//    entry may have no duration and an individuals-only entry has no team.
//  - one device workout could be logged once per person; it can now go into each challenge it
//    fits, so the uniqueness rule gains challenge_id.
// Detected from the live schema, so it runs only while the table still has an old shape.
function activityUniqueColumns(){
  for(const ix of db.prepare('PRAGMA index_list(activities)').all()){
    if(!ix.unique||ix.origin!=='u')continue;
    return db.prepare(`PRAGMA index_info(${JSON.stringify(ix.name)})`).all().map(c=>c.name).join(',');
  }
  return '';
}
function relaxActivityColumns(){
  const cols=db.prepare('PRAGMA table_info(activities)').all();
  const oldNotNull=cols.some(c=>(c.name==='minutes'||c.name==='team_id')&&c.notnull);
  const oldUnique=activityUniqueColumns()!=='user_id,source,source_ref,challenge_id';
  if(!oldNotNull&&!oldUnique)return;
  const names=cols.map(c=>c.name).join(',');
  db.exec('PRAGMA foreign_keys=OFF');
  try{
    db.exec('BEGIN');
    db.exec(`CREATE TABLE activities_new(id INTEGER PRIMARY KEY,user_id INTEGER NOT NULL,team_id INTEGER,challenge_id INTEGER NOT NULL,activity_type TEXT NOT NULL,minutes INTEGER CHECK(minutes>0),activity_date TEXT NOT NULL,source TEXT NOT NULL DEFAULT 'manual',source_ref TEXT,created_at TEXT DEFAULT CURRENT_TIMESTAMP,start_time TEXT,end_time TEXT,comment TEXT,distance_m REAL,route_id INTEGER,steps INTEGER,UNIQUE(user_id,source,source_ref,challenge_id),FOREIGN KEY(user_id) REFERENCES users(id),FOREIGN KEY(team_id) REFERENCES teams(id),FOREIGN KEY(challenge_id) REFERENCES challenges(id))`);
    db.exec(`INSERT INTO activities_new(${names}) SELECT ${names} FROM activities`);
    db.exec('DROP TABLE activities');
    db.exec('ALTER TABLE activities_new RENAME TO activities');
    db.exec('COMMIT');
    console.log('Migrated activities to the current shape (optional minutes and team; one device workout per challenge)');
  }catch(e){db.exec('ROLLBACK');throw e}
  finally{db.exec('PRAGMA foreign_keys=ON')}
}
relaxActivityColumns();
// Steps for a step challenge: one entry per day (a phone counts steps all day, not per workout).
// Added after the rebuild above so an old table is reshaped before it gains the column.
ensureColumn('activities','steps','INTEGER');

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
// The shared Apple Shortcut (an iCloud link made on an iPhone); the website offers it once set.
const SHORTCUT_URL=/^https:\/\/www\.icloud\.com\/shortcuts\/[A-Za-z0-9]+$/.test(process.env.SHORTCUT_URL||'')?process.env.SHORTCUT_URL:'';
async function verifyRecaptcha(token,ip){
  if(!RECAPTCHA_SECRET_KEY)return true;
  if(!token)return false;
  try{
    const r=await fetch('https://www.google.com/recaptcha/api/siteverify',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({secret:RECAPTCHA_SECRET_KEY,response:token,remoteip:ip})});
    const j=await r.json();
    return j.success===true;
  }catch(e){console.error('reCAPTCHA verification request failed',e);return false}
}
function attemptLogin(email,password){const x=db.prepare('SELECT * FROM users WHERE email=?').get(String(email||'').toLowerCase());if(!x||!verify(password||'',x.password_hash))return null;if(x.deactivated_at)return {deactivated:true};const t=startSession(x.id);return {sessionToken:t,user:{id:x.id,email:x.email,name:x.name,role:x.role,avatarUrl:x.avatar_url}}}

// Excludes 0/O/1/I/L to avoid transcription mistakes when someone reads a code aloud or off a screen.
const CODE_ALPHABET='ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const genCode=(len=8)=>{const b=crypto.randomBytes(len);let s='';for(let i=0;i<len;i++)s+=CODE_ALPHABET[b[i]%CODE_ALPHABET.length];return s};
const isUniqueViolation=e=>/UNIQUE constraint failed/i.test(e.message||'');

function insertChallenge(name,start_date,end_date,uid,description=null,metric='minutes',distance_unit='mi',participation='teams'){
  for(let attempt=0;attempt<10;attempt++){
    const code=genCode();
    try{
      const r=db.prepare('INSERT INTO challenges(name,start_date,end_date,created_by,invite_code,description,metric,distance_unit,participation) VALUES(?,?,?,?,?,?,?,?,?)').run(name,start_date,end_date,uid,code,description,metric,distance_unit,participation);
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
      pruneRoutes();
      console.log(`Purged challenge ${id}: past its 60-day post-end retention window`);
    }catch(e){db.exec('ROLLBACK');console.error('Failed to purge expired challenge',id,e)}
  }
}
purgeExpiredChallenges();
setInterval(purgeExpiredChallenges,24*60*60*1000).unref();

const send=(res,status,data,headers={})=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store',...headers});res.end(JSON.stringify(data))};
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
function auth(req){const t=sessionToken(req);if(!t)return null;return db.prepare(`SELECT u.id,u.email,u.name,u.role,u.avatar_url,u.bio,u.profile_sharing FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>datetime('now') AND u.deactivated_at IS NULL`).get(crypto.createHash('sha256').update(t).digest('hex'))||null}
const need=(res,u,roles)=>{if(!u){send(res,401,{error:'Sign in required'});return false}if(roles&&!roles.includes(u.role)){send(res,403,{error:'Not authorised'});return false}return true};
const setSessionCookie=t=>({'Set-Cookie':`session=${t}; HttpOnly; SameSite=Strict; Path=/; Max-Age=604800`});
function startSession(uid){const t=crypto.randomBytes(32).toString('hex'),th=crypto.createHash('sha256').update(t).digest('hex');db.prepare("INSERT INTO sessions VALUES(?,?,datetime('now','+7 days'))").run(th,uid);return t}

function teamAccess(uid,tid){return db.prepare('SELECT team_role FROM team_members WHERE user_id=? AND team_id=?').get(uid,tid)}
function challengeAccess(uid,cid){return db.prepare('SELECT challenge_role FROM challenge_members WHERE user_id=? AND challenge_id=?').get(uid,cid)}
function sharesChallenge(a,b){return !!db.prepare('SELECT 1 FROM challenge_members x JOIN challenge_members y ON y.challenge_id=x.challenge_id WHERE x.user_id=? AND y.user_id=? LIMIT 1').get(a,b)}
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
// --- what a challenge measures ------------------------------------------------------------
const METERS_PER={mi:1609.344,km:1000};
const METRICS=['minutes','distance','steps'];
const challengeMetric=c=>c&&METRICS.includes(c.metric)?c.metric:'minutes';
const PROFILE_SHARING=['private','summary','full'];
const isIndividual=c=>!!c&&c.participation==='individual';
// Where an activity may be logged. A team challenge needs a team of that challenge the user is in
// (as before); an individuals-only challenge needs only membership, and the activity has no team.
// Returns {teamId} or an {error,status} to send back.
function activityTarget(u,challenge,rawTeamId){
  if(!challenge)return {error:'Challenge not found',status:404};
  if(isIndividual(challenge)){
    if(!challengeAccess(u.id,challenge.id))return {error:'Join the challenge before logging activity in it',status:403};
    return {teamId:null};
  }
  const teamId=Number(rawTeamId),team=db.prepare('SELECT challenge_id FROM teams WHERE id=?').get(teamId);
  if(!team||team.challenge_id!==challenge.id)return {error:'That team is not part of this challenge',status:400};
  if(!teamAccess(u.id,teamId))return {error:'You are not in this team',status:403};
  return {teamId};
}
const challengeUnit=c=>c&&c.distance_unit==='km'?'km':'mi';
// Display figure in the challenge's own unit, to 2dp - totals are summed in metres first so
// rounding never accumulates across entries.
const metersToUnit=(m,unit)=>Math.round(((Number(m)||0)/METERS_PER[unit==='km'?'km':'mi'])*100)/100;
// metric/distance_unit as sent on create or edit: undefined means "not sent" (keep what is there).
function parseChallengeMeasure(b){
  const out={};
  if(b.metric!==undefined){if(!METRICS.includes(b.metric))throw new Error('metric must be minutes, distance or steps');out.metric=b.metric}
  if(b.distance_unit!==undefined){if(!METERS_PER[b.distance_unit])throw new Error('distance_unit must be mi or km');out.distance_unit=b.distance_unit}
  if(b.participation!==undefined){if(!['teams','individual'].includes(b.participation))throw new Error('participation must be teams or individual');out.participation=b.participation}
  return out;
}
// Both inputs return undefined when the field was not sent, null when it was sent empty (clear
// it), or a positive number. Distance arrives either as distance_m (device sync, already metres)
// or as distance plus a unit (the web form, in the challenge's unit).
function parseMinutes(v){
  if(v===undefined)return undefined;
  if(v===null||v==='')return null;
  const n=Number(v);
  if(!Number.isFinite(n)||n<=0)throw new Error('Minutes must be a positive number');
  return n;
}
// Steps: undefined when not sent, null when sent empty, else a whole number (a day's count, so capped
// well above anything a person walks).
function parseSteps(v){
  if(v===undefined)return undefined;
  if(v===null||v==='')return null;
  const n=Number(v);
  if(!Number.isInteger(n)||n<=0)throw new Error('Steps must be a whole number above zero');
  if(n>200000)throw new Error('That is more steps than anyone walks in a day - check the number');
  return n;
}
function parseDistance(b,fallbackUnit){
  if(b.distance_m!==undefined){
    if(b.distance_m===null||b.distance_m==='')return null;
    const n=Number(b.distance_m);
    if(!Number.isFinite(n)||n<=0)throw new Error('Distance must be a positive number');
    return n;
  }
  if(b.distance===undefined)return undefined;
  if(b.distance===null||b.distance==='')return null;
  const unit=b.distance_unit||fallbackUnit;
  if(!METERS_PER[unit])throw new Error('distance_unit must be mi or km');
  const n=Number(b.distance);
  if(!Number.isFinite(n)||n<=0)throw new Error('Distance must be a positive number');
  return n*METERS_PER[unit];
}
// --- GPS routes ----------------------------------------------------------------------------
// A route arrives as [[lat,lon,timeMs?,elevation?],...] from a device sync or a GPX file. It is
// validated point by point, thinned evenly to at most ROUTE_MAX_POINTS (enough to draw a clear
// line; a 1Hz watch track of a long ride can be tens of thousands) and stored compactly, once per
// workout, shared by every challenge entry made from it. Only its owner can read it back.
const ROUTE_MAX_INPUT=50000,ROUTE_MAX_POINTS=3000;
function parseRoute(raw){
  if(raw===undefined||raw===null)return null;
  if(!Array.isArray(raw))throw new Error('route must be an array of [lat,lon] points');
  if(raw.length>ROUTE_MAX_INPUT)throw new Error(`route has too many points (max ${ROUTE_MAX_INPUT})`);
  const pts=[];
  for(const p of raw){
    if(!Array.isArray(p)||p.length<2)continue;
    const lat=Number(p[0]),lon=Number(p[1]);
    if(!Number.isFinite(lat)||!Number.isFinite(lon)||lat<-90||lat>90||lon<-180||lon>180)continue;
    const pt=[Math.round(lat*1e6)/1e6,Math.round(lon*1e6)/1e6];
    const t=Number(p[2]),ele=Number(p[3]);
    if(p[2]!=null&&Number.isFinite(t))pt[2]=Math.round(t);
    if(p[3]!=null&&Number.isFinite(ele)){if(pt.length<3)pt[2]=null;pt[3]=Math.round(ele*10)/10}
    pts.push(pt);
  }
  if(pts.length<2)return null;
  if(pts.length<=ROUTE_MAX_POINTS)return pts;
  const step=(pts.length-1)/(ROUTE_MAX_POINTS-1),out=[];
  for(let i=0;i<ROUTE_MAX_POINTS;i++)out.push(pts[Math.round(i*step)]);
  return out;
}
// Stored once per (user, source, ref); a second challenge entry for the same workout reuses it.
function saveRoute(uid,source,ref,points){
  if(!points)return null;
  db.prepare('INSERT OR IGNORE INTO routes(user_id,source,source_ref,points,point_count) VALUES(?,?,?,?,?)').run(uid,source,ref,JSON.stringify(points),points.length);
  return db.prepare('SELECT id FROM routes WHERE user_id=? AND source=? AND source_ref=?').get(uid,source,ref).id;
}
// Routes go when the last activity using them does - called after every path that deletes activity.
function pruneRoutes(){db.prepare('DELETE FROM routes WHERE id NOT IN (SELECT route_id FROM activities WHERE route_id IS NOT NULL)').run()}
// Request bodies that can carry a route get more room than the 1MB default.
const ROUTE_BODY_MAX=8e6;

// An activity counts only if it happened while the challenge was running - a device sync used to
// bring in a month of older workouts. Dates are YYYY-MM-DD strings, so they compare as text.
const DATE_RE=/^\d{4}-\d{2}-\d{2}$/;
function requireInWindow(challenge,date){
  if(!DATE_RE.test(String(date||'')))throw new Error('Activity date must be YYYY-MM-DD');
  if(date<challenge.start_date||date>challenge.end_date)throw new Error(`This challenge runs from ${challenge.start_date} to ${challenge.end_date} - the activity date must fall within it`);
}
// The challenge's own measure is required; the other is optional extra detail.
function requireMeasure(challenge,minutes,distance_m,steps,activityType){
  requireJourneyMode(challenge,activityType);
  const metric=challengeMetric(challenge);
  if(metric==='distance'){if(!distance_m)throw new Error('This challenge measures distance - enter how far you went')}
  else if(metric==='steps'){if(!steps)throw new Error('This challenge counts steps - enter your step count for the day')}
  else if(!minutes)throw new Error('This challenge measures active minutes - enter how long you were active');
}
// Shared by self-service PATCH /api/me and admin PATCH /api/admin/users/:id. Role is deliberately
// not handled here - only the admin route may touch it, so a self-service caller can never grant
// themselves admin.
function updateUserFields(id,{name,email,passwordHash,avatarUrl}){const sets=[],params=[];if(name!==undefined){sets.push('name=?');params.push(name)}if(email!==undefined){sets.push('email=?');params.push(email)}if(passwordHash!==undefined){sets.push('password_hash=?');params.push(passwordHash)}if(avatarUrl!==undefined){sets.push('avatar_url=?');params.push(avatarUrl)}if(!sets.length)return false;params.push(id);db.prepare(`UPDATE users SET ${sets.join(',')} WHERE id=?`).run(...params);return true}

function dashboard(uid){
  const challenges=db.prepare(`SELECT c.id,c.name,c.description,c.start_date,c.end_date,c.active,c.invite_code,c.metric,c.distance_unit,c.participation,c.kind,c.journey_mode,c.route_shape,c.route_from,c.route_to,c.route_via,c.route_m,cm.challenge_role FROM challenges c JOIN challenge_members cm ON cm.challenge_id=c.id WHERE cm.user_id=? ORDER BY c.start_date DESC`).all(uid);
  for(const c of challenges){
    c.role=c.challenge_role; delete c.challenge_role;
    c.kind=isJourney(c)?'journey':'standard';c.journey=journeyInfo(c);
    for(const k of ['journey_mode','route_shape','route_from','route_to','route_via','route_m'])delete c[k];
    c.teams=db.prepare(`SELECT t.id,t.name,t.invite_code,tm.team_role,(SELECT COUNT(*) FROM team_members z WHERE z.team_id=t.id) members FROM teams t JOIN team_members tm ON tm.team_id=t.id WHERE tm.user_id=? AND t.challenge_id=? ORDER BY t.name`).all(uid,c.id);
    const tot=db.prepare('SELECT COALESCE(SUM(minutes),0) m,COALESCE(SUM(distance_m),0) d,COALESCE(SUM(steps),0) s FROM activities WHERE user_id=? AND challenge_id=?').get(uid,c.id);
    c.myMinutes=tot.m;c.mySteps=tot.s;
    c.myDistance=metersToUnit(tot.d,c.distance_unit);
  }
  const mine=db.prepare(`SELECT a.*,t.name team_name,c.name challenge_name,c.distance_unit FROM activities a LEFT JOIN teams t ON t.id=a.team_id JOIN challenges c ON c.id=a.challenge_id WHERE a.user_id=? ORDER BY activity_date DESC,a.id DESC LIMIT 20`).all(uid);
  for(const a of mine){a.distance=a.distance_m==null?null:metersToUnit(a.distance_m,a.distance_unit);a.has_route=a.route_id!=null;delete a.route_id}
  return {challenges,mine};
}

// Team and individual standings for one challenge, ranked by whatever it measures. Both totals
// come back either way (minutes, and distance in the challenge's unit) so the page can show the
// secondary figure too; the ORDER BY column is chosen from a fixed pair, never from input.
function leaderboard(challenge){
  const cid=challenge.id,unit=challengeUnit(challenge),order={distance:'distance_m',steps:'steps'}[challengeMetric(challenge)]||'minutes';
  const teams=db.prepare(`SELECT t.id,t.name,t.image_url,COALESCE(SUM(a.minutes),0) minutes,COALESCE(SUM(a.distance_m),0) distance_m,COALESCE(SUM(a.steps),0) steps FROM teams t LEFT JOIN activities a ON a.team_id=t.id WHERE t.challenge_id=? GROUP BY t.id ORDER BY ${order} DESC,t.name`).all(cid);
  const users=db.prepare(`SELECT us.id,us.name,us.email,us.avatar_url,COALESCE(SUM(a.minutes),0) minutes,COALESCE(SUM(a.distance_m),0) distance_m,COALESCE(SUM(a.steps),0) steps FROM challenge_members cmem JOIN users us ON us.id=cmem.user_id LEFT JOIN activities a ON a.user_id=us.id AND a.challenge_id=cmem.challenge_id WHERE cmem.challenge_id=? GROUP BY us.id ORDER BY ${order} DESC,us.name`).all(cid);
  const shape=({distance_m,...r})=>({...r,distance:metersToUnit(distance_m,unit)});
  return {teams:teams.map(shape),users:users.map(shape)};
}

// --- Virtual journeys ----------------------------------------------------------------------------
const STRIDE_M=0.762;                       // an average step: about 2,100 steps to the mile
const CYCLING_RE=/cycl|bik(e|ing)|\bride\b|spin/i;
const isJourney=c=>!!c&&c.kind==='journey';
const isCyclingType=t=>CYCLING_RE.test(String(t||''));
// A cycling journey takes only rides; an on-foot journey takes everything except rides.
function requireJourneyMode(c,activityType){
  if(!isJourney(c))return;
  const ride=isCyclingType(activityType);
  if(c.journey_mode==='cycling'&&!ride)throw new Error('This is a cycling journey - only rides count. Log it as Cycling.');
  if(c.journey_mode!=='cycling'&&ride)throw new Error("This journey is on foot - rides don't count in it");
}
const ROUTING_BASE=(process.env.ROUTING_BASE||'https://routing.openstreetmap.de').replace(/\/$/,'');
const GEOCODER_BASE=(process.env.GEOCODER_BASE||'https://nominatim.openstreetmap.org').replace(/\/$/,'');
const OUTBOUND_UA=`ActiveTogether/1.0 (${ORIGIN})`;
const toRad=d=>d*Math.PI/180;
function haversineM(a,b){const R=6371008.8,dLat=toRad(b[0]-a[0]),dLon=toRad(b[1]-a[1]),h=Math.sin(dLat/2)**2+Math.cos(toRad(a[0]))*Math.cos(toRad(b[0]))*Math.sin(dLon/2)**2;return 2*R*Math.asin(Math.sqrt(h))}
const lineLength=pts=>{let m=0;for(let i=1;i<pts.length;i++)m+=haversineM(pts[i-1],pts[i]);return m};
// Points along the great circle between two places, so a long straight route still draws as the
// shortest path on the map.
function greatCircle(a,b,n=64){
  const [p1,l1,p2,l2]=[toRad(a[0]),toRad(a[1]),toRad(b[0]),toRad(b[1])];
  const d=2*Math.asin(Math.sqrt(Math.sin((p2-p1)/2)**2+Math.cos(p1)*Math.cos(p2)*Math.sin((l2-l1)/2)**2));
  if(d<1e-9)return [a,b];
  const out=[];
  for(let i=0;i<=n;i++){
    const f=i/n,A=Math.sin((1-f)*d)/Math.sin(d),B=Math.sin(f*d)/Math.sin(d);
    const x=A*Math.cos(p1)*Math.cos(l1)+B*Math.cos(p2)*Math.cos(l2),y=A*Math.cos(p1)*Math.sin(l1)+B*Math.cos(p2)*Math.sin(l2),z=A*Math.sin(p1)+B*Math.sin(p2);
    out.push([+(Math.atan2(z,Math.hypot(x,y))*180/Math.PI).toFixed(5),+(Math.atan2(y,x)*180/Math.PI).toFixed(5)]);
  }
  return out;
}
// Ramer-Douglas-Peucker on a local flat projection, loosened until the line fits in maxPts.
function simplifyLine(pts,maxPts=800){
  if(pts.length<=maxPts)return pts;
  const lat0=toRad(pts[0][0]),xy=pts.map(p=>[toRad(p[1])*Math.cos(lat0)*6371008.8,toRad(p[0])*6371008.8]);
  const run=eps=>{
    const keep=new Uint8Array(pts.length);keep[0]=keep[pts.length-1]=1;
    const stack=[[0,pts.length-1]];
    while(stack.length){
      const [i,j]=stack.pop();let best=-1,bi=-1;
      const [ax,ay]=xy[i],[bx,by]=xy[j],dx=bx-ax,dy=by-ay,len2=dx*dx+dy*dy||1;
      for(let k=i+1;k<j;k++){
        const t=Math.max(0,Math.min(1,((xy[k][0]-ax)*dx+(xy[k][1]-ay)*dy)/len2));
        const d=Math.hypot(xy[k][0]-(ax+t*dx),xy[k][1]-(ay+t*dy));
        if(d>best){best=d;bi=k}
      }
      if(best>eps){keep[bi]=1;stack.push([i,bi],[bi,j])}
    }
    return pts.filter((_,k)=>keep[k]);
  };
  let eps=20,out=run(eps);
  while(out.length>maxPts){eps*=1.6;out=run(eps)}
  return out;
}
function parsePlace(p,label){
  const lat=Number(p&&p.lat),lon=Number(p&&p.lon),name=String((p&&p.name)||'').trim().slice(0,120);
  if(!Number.isFinite(lat)||!Number.isFinite(lon)||Math.abs(lat)>90||Math.abs(lon)>180)throw new Error(`Choose the ${label} on the map`);
  return {name:name||`${lat.toFixed(4)}, ${lon.toFixed(4)}`,lat:+lat.toFixed(6),lon:+lon.toFixed(6)};
}
const MAX_STOPS=10;
function parseJourney(b){
  const j=b.journey||{};
  const from=parsePlace(j.from,'start'),to=parsePlace(j.to,'finish');
  const rawVia=Array.isArray(j.via)?j.via:[];
  if(rawVia.length>MAX_STOPS)throw new Error(`A journey can have up to ${MAX_STOPS} stops on the way`);
  const via=rawVia.map((p,i)=>parsePlace(p,`stop ${i+1}`));
  const shape=j.shape==='straight'?'straight':'roads',mode=j.mode==='cycling'?'cycling':'foot';
  return {from,to,via,shape,mode};
}
const routeCache=new Map();
// The route between two places: by road (walking or cycling directions from the public OSRM servers
// run by FOSSGIS) or as the crow flies. Cached for an hour, so previewing then creating asks once.
async function buildRoute({from,to,via=[],shape,mode}){
  const places=[from,...via,to];
  const key=JSON.stringify([places.map(p=>[p.lat,p.lon]),shape,mode]);
  const hit=routeCache.get(key);if(hit&&hit.at>Date.now()-36e5)return hit.route;
  let points,legs;
  if(shape==='straight'){
    // One great-circle arc per leg, joined end to end.
    points=[];legs=[];
    for(let i=1;i<places.length;i++){
      const a=[places[i-1].lat,places[i-1].lon],b=[places[i].lat,places[i].lon];
      points.push(...greatCircle(a,b,places.length>2?32:64).slice(i>1?1:0));
      legs.push(haversineM(a,b));
    }
  }else{
    const coords=places.map(p=>`${p.lon},${p.lat}`).join(';');
    const url=`${ROUTING_BASE}/routed-${mode==='cycling'?'bike':'foot'}/route/v1/driving/${coords}?overview=full&geometries=geojson`;
    let j;
    try{const r=await fetch(url,{headers:{'User-Agent':OUTBOUND_UA},signal:AbortSignal.timeout(30000)});j=await r.json()}
    catch(e){throw new Error("Couldn't reach the route planner just now - try again, or choose a straight line")}
    if(j.code!=='Ok'||!j.routes||!j.routes.length)throw new Error('No route found between those places - try a straight line instead');
    points=simplifyLine(j.routes[0].geometry.coordinates.map(([lon,lat])=>[+lat.toFixed(5),+lon.toFixed(5)]));
    legs=(j.routes[0].legs||[]).map(l=>l.distance);
    if(legs.length!==places.length-1)legs=[j.routes[0].distance];
  }
  const length=legs.reduce((a,b)=>a+b,0);
  if(!(length>=100))throw new Error('Those places are too close together - choose a finish further away');
  if(length>40075e3)throw new Error('That route is longer than the way round the world');
  // How far along the route each stop on the way is.
  let run=0;const stops=via.map((p,i)=>({...p,at_m:Math.round(run+=legs[i]||0)}));
  const route={points,length_m:Math.round(length),stops};
  routeCache.set(key,{at:Date.now(),route});
  return route;
}
// What one team or person has covered, in metres along the route: their distance, or their steps at
// an average stride in a steps journey.
const coveredM=(c,row)=>challengeMetric(c)==='steps'?(Number(row.steps)||0)*STRIDE_M:(Number(row.distance_m)||0);
// Where a fraction of the way along the stored line falls. The stored line is simplified, so its own
// length stands in for the real one, proportionally.
function pointAlong(points,fraction){
  const f=Math.max(0,Math.min(1,fraction)),total=lineLength(points);
  let want=f*total;
  for(let i=1;i<points.length;i++){
    const seg=haversineM(points[i-1],points[i]);
    if(want<=seg||i===points.length-1){const t=seg?Math.min(1,want/seg):0;return [+(points[i-1][0]+(points[i][0]-points[i-1][0])*t).toFixed(5),+(points[i-1][1]+(points[i][1]-points[i-1][1])*t).toFixed(5)]}
    want-=seg;
  }
  return points[points.length-1];
}
// A journey measures distance or steps (not minutes); a cycling journey measures distance.
function checkJourneyMeasure(metric,mode){
  if(metric!=='distance'&&metric!=='steps')throw new Error('A journey measures distance or steps');
  if(mode==='cycling'&&metric!=='distance')throw new Error('A cycling journey measures distance, in miles or km');
}
function saveJourney(id,j,route){
  db.prepare("UPDATE challenges SET kind='journey',journey_mode=?,route_shape=?,route_from=?,route_to=?,route_via=?,route=?,route_m=? WHERE id=?")
    .run(j.mode,j.shape,JSON.stringify(j.from),JSON.stringify(j.to),JSON.stringify(route.stops||[]),JSON.stringify(route.points),route.length_m,id);
}
// The challenge record as the API shows it: the route line itself only comes from /journey.
const publicChallenge=c=>({id:c.id,name:c.name,description:c.description,start_date:c.start_date,end_date:c.end_date,active:c.active,invite_code:c.invite_code,
  created_by:c.created_by,metric:c.metric,distance_unit:c.distance_unit,participation:c.participation,kind:isJourney(c)?'journey':'standard',journey:journeyInfo(c)});
// Place search for the journey map, through Nominatim (OpenStreetMap). Its usage policy allows at most
// one request a second, so requests queue one at a time with a gap; answers are cached for a day.
const placeCache=new Map();let geocoderQueue=Promise.resolve();
function geocoderFetch(pathAndQuery){
  const hit=placeCache.get(pathAndQuery);
  if(hit&&hit.at>Date.now()-864e5)return Promise.resolve(hit.data);
  const job=geocoderQueue.then(async()=>{
    const r=await fetch(GEOCODER_BASE+pathAndQuery,{headers:{'User-Agent':OUTBOUND_UA,'Accept-Language':'en'},signal:AbortSignal.timeout(15000)});
    if(!r.ok)throw new Error('Place search is unavailable just now');
    const data=await r.json();placeCache.set(pathAndQuery,{at:Date.now(),data});return data;
  });
  geocoderQueue=job.catch(()=>{}).then(()=>new Promise(r=>setTimeout(r,1100)));
  return job;
}
function journeyInfo(c){
  if(!isJourney(c))return null;
  const steps=challengeMetric(c)==='steps',length=c.route_m||0;
  // Lengths in what the challenge counts: its distance unit, or steps at an average stride.
  const inUnit=m=>steps?Math.round(m/STRIDE_M):metersToUnit(m,challengeUnit(c));
  return {mode:c.journey_mode==='cycling'?'cycling':'foot',shape:c.route_shape==='straight'?'straight':'roads',
    from:JSON.parse(c.route_from||'null'),to:JSON.parse(c.route_to||'null'),
    via:JSON.parse(c.route_via||'[]').map(({at_m,...p})=>({...p,at_m,at:inUnit(at_m)})),length_m:length,
    target:inUnit(length),unit:steps?'steps':challengeUnit(c)};
}
// The next place someone reaches - a stop on the way, or the finish - and how far off it is, in the
// challenge's unit. Null once they've finished.
function nextStop(info,coveredMeters){
  if(coveredMeters>=info.length_m)return null;
  const s=info.via.find(v=>v.at_m>coveredMeters),at=s?s.at_m:info.length_m,steps=info.unit==='steps';
  const left=at-coveredMeters;
  return {name:s?s.name:info.to.name,finish:!s,remaining:steps?Math.round(left/STRIDE_M):metersToUnit(left,info.unit)};
}
// Progress, virtual position and finishing day for each team (team challenges) or person. A finish
// day is the day their running total first reached the end of the route.
function journeyStandings(c){
  const lb=leaderboard(c),info=journeyInfo(c),points=JSON.parse(c.route||'[]');
  if(!info||!points.length)return null;
  const byTeam=!isIndividual(c),col=byTeam?'team_id':'user_id';
  const days=db.prepare(`SELECT ${col} who,activity_date d,COALESCE(SUM(distance_m),0) distance_m,COALESCE(SUM(steps),0) steps FROM activities WHERE challenge_id=? AND ${col} IS NOT NULL GROUP BY ${col},activity_date ORDER BY activity_date`).all(c.id);
  const finished={},running={};
  for(const r of days){running[r.who]=(running[r.who]||0)+coveredM(c,r);if(!finished[r.who]&&running[r.who]>=info.length_m)finished[r.who]=r.d}
  const shape=(rows,raw)=>rows.map(r=>{
    const m=coveredM(c,raw.find(x=>x.id===r.id)||{}),progress=info.length_m?Math.min(1,m/info.length_m):0,[lat,lon]=pointAlong(points,progress);
    return {...r,progress:Math.round(progress*10000)/10000,lat,lon,finished_on:finished[r.id]||null,next:nextStop(info,m)};
  });
  const rawTeams=db.prepare('SELECT t.id,COALESCE(SUM(a.distance_m),0) distance_m,COALESCE(SUM(a.steps),0) steps FROM teams t LEFT JOIN activities a ON a.team_id=t.id WHERE t.challenge_id=? GROUP BY t.id').all(c.id);
  const rawUsers=db.prepare('SELECT cm.user_id id,COALESCE(SUM(a.distance_m),0) distance_m,COALESCE(SUM(a.steps),0) steps FROM challenge_members cm LEFT JOIN activities a ON a.user_id=cm.user_id AND a.challenge_id=cm.challenge_id WHERE cm.challenge_id=? GROUP BY cm.user_id').all(c.id);
  return {info,points,teams:shape(lb.teams,rawTeams),users:shape(lb.users,rawUsers)};
}

// --- Help & support tickets ------------------------------------------------------------------
const TICKET_TYPES=['bug','feature','question'];
const TICKET_STATUSES=['new','in_progress','planned','done','declined'];
const TICKET_RATE_MAX=Number(process.env.TICKET_RATE_LIMIT_MAX||20),TICKET_RATE_WINDOW_MS=60*60_000;
const isAdmin=u=>u&&u.role==='global_admin';
const DEACTIVATED_MSG='This account has been deactivated. Contact an administrator if you think that is a mistake.';
// Guards for admin changes to an account: never lock yourself out, and always leave one working global admin.
function adminUserChangeError(u,target,{removesAdmin}){
  if(target.id===u.id)return 'You cannot do that to your own account';
  if(removesAdmin&&target.role==='global_admin'&&!target.deactivated_at&&
     db.prepare("SELECT COUNT(*) n FROM users WHERE role='global_admin' AND deactivated_at IS NULL").get().n<=1)return 'This is the only active global admin - make someone else an admin first';
  return null;
}
// A ticket row as the list and detail views want it, with the badge for whoever is looking: the
// reporter sees "unread" when an admin replied or changed it since they last looked; an admin sees
// it when the reporter wrote since any admin last looked.
function ticketView(t,viewer){
  const mine=t.user_id===viewer.id;
  const unread=mine?!!(t.last_reply_at&&(!t.owner_seen_at||t.last_reply_at>t.owner_seen_at))
    :isAdmin(viewer)?!t.admin_seen_at||(t.last_user_reply_at&&t.last_user_reply_at>t.admin_seen_at):false;
  return {id:t.id,type:t.type,title:t.title,description:t.description,status:t.status,resolution:t.resolution||null,image_url:t.image_url||null,
    client_info:isAdmin(viewer)?(t.client_info||null):undefined,created_at:t.created_at,updated_at:t.updated_at,
    reporter:{id:t.user_id,name:t.reporter_name,avatar_url:t.reporter_avatar||null,email:isAdmin(viewer)?t.reporter_email:undefined},
    comment_count:t.comment_count??undefined,unread,mine};
}
const TICKET_SELECT=`SELECT t.*,u.name reporter_name,u.email reporter_email,u.avatar_url reporter_avatar,
  (SELECT COUNT(*) FROM ticket_comments c WHERE c.ticket_id=t.id AND c.internal=0) comment_count FROM tickets t JOIN users u ON u.id=t.user_id`;
// Milliseconds, so a reply in the same second as a view still counts as new.
const nowIso=()=>new Date().toISOString().replace('T',' ').slice(0,23);

async function api(req,res,url){
 const ip=clientIp(req);
 if(hitRateLimit('all:'+ip,API_RATE_LIMIT_MAX,API_RATE_LIMIT_WINDOW_MS))return send(res,429,{error:'Too many requests. Please slow down and try again shortly.'});
 const u=auth(req), m=req.method;
 if(m==='GET'&&url.pathname==='/api/config')return send(res,200,{recaptchaSiteKey:RECAPTCHA_SITE_KEY||null,shortcutUrl:SHORTCUT_URL||null});
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
   if(result.deactivated)return send(res,403,{error:DEACTIVATED_MSG});
   return send(res,200,{ok:true,...result},setSessionCookie(result.sessionToken));
 }
 // Bearer-token login for the Android/iOS companion apps, which have no web page to render a
 // captcha widget in. Deliberately not recaptcha-gated; relies on the same per-IP rate limit
 // below plus the normal password check for abuse resistance instead.
 if(m==='POST'&&url.pathname==='/api/mobile/login'){
   if(hitRateLimit('mobilelogin:'+ip,AUTH_RATE_LIMIT_MAX,AUTH_RATE_LIMIT_WINDOW_MS))return send(res,429,{error:'Too many sign-in attempts from this network. Please try again later.'});
   const b=await body(req),result=attemptLogin(b.email,b.password);
   if(!result)return send(res,401,{error:'Invalid email or password'});
   if(result.deactivated)return send(res,403,{error:DEACTIVATED_MSG});
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
   const bio=b.bio!==undefined?(String(b.bio).trim().slice(0,280)||null):undefined;
   const sharing=b.profileSharing;
   if(sharing!==undefined&&!PROFILE_SHARING.includes(sharing))return send(res,400,{error:'profileSharing must be private, summary or full'});
   try{
     const profileChanged=bio!==undefined||sharing!==undefined;
     if(bio!==undefined)db.prepare('UPDATE users SET bio=? WHERE id=?').run(bio,u.id);
     if(sharing!==undefined)db.prepare('UPDATE users SET profile_sharing=? WHERE id=?').run(sharing,u.id);
     if(!updateUserFields(u.id,{name,email,passwordHash,avatarUrl})&&!profileChanged)return send(res,400,{error:'Nothing to update'});
   }catch(e){if(isUniqueViolation(e))return send(res,409,{error:'An account with that email already exists'});throw e}
   if(passwordHash){const t=sessionToken(req);db.prepare('DELETE FROM sessions WHERE user_id=? AND token_hash!=?').run(u.id,crypto.createHash('sha256').update(t).digest('hex'))}
   return send(res,200,{ok:true,user:db.prepare('SELECT id,email,name,role,avatar_url,bio,profile_sharing FROM users WHERE id=?').get(u.id)});
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
 if(m==='GET'&&url.pathname==='/api/mobile/bootstrap'){if(!need(res,u))return;return send(res,200,{user:u,...dashboard(u.id),health:{healthConnect:{platform:'Android',mode:'native-companion-required'},healthKit:{platform:'iOS',mode:'native-companion-required'},acceptedRecord:'exercise session duration and distance',uploadEndpoint:'/api/health/import'}})}

 if(m==='POST'&&url.pathname==='/api/challenges'){
   if(!need(res,u))return;
   const b=await body(req);
   if(!b.name||!b.start_date||!b.end_date)return send(res,400,{error:'name, start_date and end_date are required'});
   const description=b.description!==undefined?(sanitizeHtml(String(b.description).trim())||null):null;
   let measure,journey=null,route=null;
   try{
     measure=parseChallengeMeasure(b);
     if(b.kind==='journey'){journey=parseJourney(b);checkJourneyMeasure(measure.metric||'minutes',journey.mode);route=await buildRoute(journey)}
   }catch(e){return send(res,400,{error:e.message})}
   const {id,invite_code}=insertChallenge(String(b.name).trim(),b.start_date,b.end_date,u.id,description,measure.metric||'minutes',measure.distance_unit||'mi',measure.participation||'teams');
   if(journey)saveJourney(id,journey,route);
   return send(res,201,{id,invite_code});
 }
 if(m==='GET'&&url.pathname.match(/^\/api\/challenges\/\d+$/)){if(!need(res,u))return;const cid=Number(url.pathname.split('/')[3]),ca=challengeAccess(u.id,cid)||(isAdmin(u)?{challenge_role:'admin'}:null);if(!ca)return send(res,403,{error:'You need an invite code to view this challenge'});const c=db.prepare('SELECT * FROM challenges WHERE id=?').get(cid);if(!c)return send(res,404,{error:'Challenge not found'});const teams=db.prepare(`SELECT t.id,t.name,t.image_url,t.invite_code,(SELECT COUNT(*) FROM team_members z WHERE z.team_id=t.id) members,tm.team_role FROM teams t LEFT JOIN team_members tm ON tm.team_id=t.id AND tm.user_id=? WHERE t.challenge_id=? ORDER BY t.name`).all(u.id,cid).map(t=>{const mine=t.team_role!=null,canManage=u.role==='global_admin'||t.team_role==='team_admin'||ca.challenge_role==='owner';return {id:t.id,name:t.name,image_url:t.image_url,members:t.members,mine,canManage,invite_code:(mine||canManage)?t.invite_code:undefined}});return send(res,200,{...publicChallenge(c),role:ca.challenge_role,canManage:canManageChallenge(u,cid),teams})}
 if(m==='PATCH'&&url.pathname.match(/^\/api\/challenges\/\d+$/)){if(!need(res,u))return;const cid=Number(url.pathname.split('/')[3]),challenge=db.prepare('SELECT * FROM challenges WHERE id=?').get(cid);if(!challenge)return send(res,404,{error:'Challenge not found'});if(!canManageChallenge(u,cid))return send(res,403,{error:'Only the challenge owner can edit this challenge'});const b=await body(req),name=b.name!==undefined?String(b.name).trim():challenge.name,start_date=b.start_date!==undefined?b.start_date:challenge.start_date,end_date=b.end_date!==undefined?b.end_date:challenge.end_date,description=b.description!==undefined?(sanitizeHtml(String(b.description).trim())||null):challenge.description;if(!name||!start_date||!end_date)return send(res,400,{error:'name, start_date and end_date are required'});let measure,journey=null,route=null;try{measure=parseChallengeMeasure(b);if(b.journey!==undefined||isJourney(challenge)){journey=b.journey!==undefined?parseJourney(b):{mode:challenge.journey_mode};checkJourneyMeasure(measure.metric||challenge.metric,journey.mode);if(b.journey!==undefined)route=await buildRoute(journey)}}catch(e){return send(res,400,{error:e.message})}if(route)saveJourney(cid,journey,route);db.prepare('UPDATE challenges SET name=?,start_date=?,end_date=?,description=?,metric=?,distance_unit=?,participation=? WHERE id=?').run(name,start_date,end_date,description,measure.metric||challenge.metric,measure.distance_unit||challenge.distance_unit,measure.participation||challenge.participation,cid);return send(res,200,{ok:true})}
 // Owners and global admins can delete a challenge outright: its activities first (they reference
 // teams with no cascade), then the challenge, which cascades to members, teams, team members and
 // invites. Same order the 60-day retention purge uses.
 if(m==='DELETE'&&url.pathname.match(/^\/api\/challenges\/\d+$/)){
   if(!need(res,u))return;
   const cid=Number(url.pathname.split('/')[3]),challenge=db.prepare('SELECT id,name FROM challenges WHERE id=?').get(cid);
   if(!challenge)return send(res,404,{error:'Challenge not found'});
   if(!canManageChallenge(u,cid))return send(res,403,{error:'Only the challenge owner can delete this challenge'});
   try{
     db.exec('BEGIN');
     db.prepare('DELETE FROM activities WHERE challenge_id=?').run(cid);
     db.prepare('DELETE FROM challenges WHERE id=?').run(cid);
     db.exec('COMMIT');
   }catch(e){db.exec('ROLLBACK');throw e}
   pruneRoutes();
   console.log(`Challenge ${cid} deleted by user ${u.id}`);
   return send(res,200,{ok:true});
 }
 // Leave a challenge: your team places in it, and everything you logged in it, go with you. The
 // last owner can't leave - they add another owner first, or delete the challenge instead.
 if(m==='POST'&&url.pathname.match(/^\/api\/challenges\/\d+\/leave$/)){
   if(!need(res,u))return;
   const cid=Number(url.pathname.split('/')[3]),ca=challengeAccess(u.id,cid);
   if(!ca)return send(res,400,{error:"You're not in this challenge"});
   if(ca.challenge_role==='owner'&&db.prepare("SELECT COUNT(*) n FROM challenge_members WHERE challenge_id=? AND challenge_role='owner'").get(cid).n<=1)
     return send(res,400,{error:"You're the only owner. Make someone else an owner first, or delete the challenge."});
   try{
     db.exec('BEGIN');
     db.prepare('DELETE FROM activities WHERE challenge_id=? AND user_id=?').run(cid,u.id);
     db.prepare('DELETE FROM team_members WHERE user_id=? AND team_id IN (SELECT id FROM teams WHERE challenge_id=?)').run(u.id,cid);
     db.prepare('DELETE FROM challenge_members WHERE challenge_id=? AND user_id=?').run(cid,u.id);
     db.exec('COMMIT');
   }catch(e){db.exec('ROLLBACK');throw e}
   pruneRoutes();
   return send(res,200,{ok:true});
 }
 if(m==='GET'&&url.pathname.match(/^\/api\/challenges\/\d+\/members$/)){if(!need(res,u))return;const cid=Number(url.pathname.split('/')[3]);if(!db.prepare('SELECT id FROM challenges WHERE id=?').get(cid))return send(res,404,{error:'Challenge not found'});if(!canManageChallenge(u,cid))return send(res,403,{error:'Only a challenge owner can view this'});const members=db.prepare('SELECT us.id,us.name,us.email,cm.challenge_role FROM challenge_members cm JOIN users us ON us.id=cm.user_id WHERE cm.challenge_id=? ORDER BY cm.challenge_role,us.name').all(cid);return send(res,200,{members})}
 if(m==='POST'&&url.pathname.match(/^\/api\/challenges\/\d+\/owners$/)){if(!need(res,u))return;const cid=Number(url.pathname.split('/')[3]);if(!db.prepare('SELECT id FROM challenges WHERE id=?').get(cid))return send(res,404,{error:'Challenge not found'});if(!canManageChallenge(u,cid))return send(res,403,{error:'Only a challenge owner can add another owner'});const b=await body(req),email=String(b.email||'').toLowerCase().trim();if(!email)return send(res,400,{error:'Email is required'});const found=db.prepare('SELECT id,name,email FROM users WHERE email=?').get(email);if(!found)return send(res,404,{error:'No account found for that email. Ask them to register first.'});const existing=db.prepare('SELECT 1 FROM challenge_members WHERE challenge_id=? AND user_id=?').get(cid,found.id);if(existing)db.prepare("UPDATE challenge_members SET challenge_role='owner' WHERE challenge_id=? AND user_id=?").run(cid,found.id);else db.prepare("INSERT INTO challenge_members(challenge_id,user_id,challenge_role) VALUES(?,?,'owner')").run(cid,found.id);return send(res,201,{ok:true,user:found})}
 if(m==='GET'&&url.pathname.match(/^\/api\/challenges\/\d+\/leaderboard\/export$/)){if(!need(res,u))return;const cid=Number(url.pathname.split('/')[3]),challenge=db.prepare('SELECT * FROM challenges WHERE id=?').get(cid);if(!challenge)return send(res,404,{error:'Challenge not found'});if(!canManageChallenge(u,cid))return send(res,403,{error:'Only the challenge owner or a global admin can export the leaderboard'});const type=url.searchParams.get('type')==='users'?'users':'teams';const lb=leaderboard(challenge),metric=challengeMetric(challenge),dist=metric==='distance',unitName=challengeUnit(challenge)==='km'?'Kilometres':'Miles';
   // A minutes challenge exports exactly as before; a distance challenge leads with distance and
   // keeps minutes alongside, since synced entries usually carry both.
   const valueCols=metric==='steps'?['Steps']:dist?[unitName,'Minutes']:['Minutes'],values=r=>metric==='steps'?[r.steps]:dist?[r.distance,r.minutes]:[r.minutes];let header,rows;if(type==='teams'){header=['Rank','Team',...valueCols];rows=lb.teams.map((r,i)=>[i+1,r.name,...values(r)])}else{header=['Rank','Name','Email',...valueCols];rows=lb.users.map((r,i)=>[i+1,r.name,r.email,...values(r)])}const csv=[header,...rows].map(r=>r.map(csvEscape).join(',')).join('\r\n'),safeName=challenge.name.replace(/[^a-z0-9]+/gi,'-').toLowerCase()||'challenge';res.writeHead(200,{'Content-Type':'text/csv; charset=utf-8','Content-Disposition':`attachment; filename="${safeName}-${type}.csv"`});return res.end(csv)}
 if(m==='GET'&&url.pathname.match(/^\/api\/challenges\/\d+\/leaderboard$/)){if(!need(res,u))return;const cid=Number(url.pathname.split('/')[3]);if(!challengeAccess(u.id,cid)&&!isAdmin(u))return send(res,403,{error:'You need an invite code to view this challenge'});const challenge=db.prepare('SELECT * FROM challenges WHERE id=?').get(cid);if(!challenge)return send(res,404,{error:'Challenge not found'});const lb=isJourney(challenge)?journeyStandings(challenge)||leaderboard(challenge):leaderboard(challenge),strip=({email,lat,lon,...r})=>r;return send(res,200,{metric:challengeMetric(challenge),distance_unit:challengeUnit(challenge),participation:isIndividual(challenge)?'individual':'teams',journey:journeyInfo(challenge),teams:lb.teams.map(strip),users:lb.users.map(strip)})}
 // The journey map: the route, and where each team (or, in an individuals challenge, each person) has
 // got to along it - a virtual position worked out from their total, never anyone's real location.
 if(m==='GET'&&url.pathname.match(/^\/api\/challenges\/\d+\/journey$/)){
   if(!need(res,u))return;
   const cid=Number(url.pathname.split('/')[3]);
   if(!challengeAccess(u.id,cid)&&!isAdmin(u))return send(res,403,{error:'You need an invite code to view this challenge'});
   const c=db.prepare('SELECT * FROM challenges WHERE id=?').get(cid);
   if(!c)return send(res,404,{error:'Challenge not found'});
   const js=isJourney(c)&&journeyStandings(c);
   if(!js)return send(res,404,{error:'This challenge is not a journey'});
   const rows=isIndividual(c)?js.users:js.teams;
   return send(res,200,{journey:js.info,route:js.points,by:isIndividual(c)?'person':'team',
     markers:rows.map(r=>({id:r.id,name:r.name,image_url:r.image_url||r.avatar_url||null,distance:r.distance,steps:r.steps,progress:r.progress,lat:r.lat,lon:r.lon,finished_on:r.finished_on,next:r.next}))});
 }
 // For the journey picker: find places by name, name a tapped point, and preview a route's length.
 if(m==='GET'&&url.pathname==='/api/places'){
   if(!need(res,u))return;
   const q=String(url.searchParams.get('q')||'').trim().slice(0,120);
   if(q.length<2)return send(res,400,{error:'Type a place to search for'});
   try{
     const r=await geocoderFetch(`/search?format=jsonv2&limit=6&q=${encodeURIComponent(q)}`);
     return send(res,200,{places:r.map(x=>({name:x.name||String(x.display_name).split(',')[0],detail:x.display_name,lat:+x.lat,lon:+x.lon}))});
   }catch(e){return send(res,502,{error:e.message})}
 }
 if(m==='GET'&&url.pathname==='/api/places/reverse'){
   if(!need(res,u))return;
   const lat=Number(url.searchParams.get('lat')),lon=Number(url.searchParams.get('lon'));
   if(!Number.isFinite(lat)||!Number.isFinite(lon))return send(res,400,{error:'lat and lon are required'});
   try{
     const d=await geocoderFetch(`/reverse?format=jsonv2&zoom=12&lat=${lat.toFixed(5)}&lon=${lon.toFixed(5)}`);
     const a=d.address||{};
     return send(res,200,{name:d.name||a.city||a.town||a.village||a.county||String(d.display_name||'').split(',')[0]||null});
   }catch(e){return send(res,200,{name:null})}
 }
 if(m==='POST'&&url.pathname==='/api/journeys/preview'){
   if(!need(res,u))return;
   const b=await body(req);
   try{
     const j=parseJourney(b),route=await buildRoute(j);
     return send(res,200,{length_m:route.length_m,miles:metersToUnit(route.length_m,'mi'),km:metersToUnit(route.length_m,'km'),steps:Math.round(route.length_m/STRIDE_M),points:route.points,
       stops:route.stops.map(s=>({name:s.name,lat:s.lat,lon:s.lon,miles:metersToUnit(s.at_m,'mi'),km:metersToUnit(s.at_m,'km')}))});
   }catch(e){return send(res,400,{error:e.message})}
 }

 // What an invite link is for, so the page (or app) can ask "join X?" first. Works signed out too:
 // anyone holding the code could join anyway, so naming the challenge reveals nothing more.
 if(m==='GET'&&url.pathname==='/api/join/preview'){
   const code=String(url.searchParams.get('code')||'').trim().toUpperCase();
   const team=code&&db.prepare('SELECT id,name,challenge_id,image_url,(SELECT COUNT(*) FROM team_members z WHERE z.team_id=teams.id) members FROM teams WHERE invite_code=?').get(code);
   const c=code&&db.prepare(`SELECT id,name,start_date,end_date,metric,distance_unit,participation,(SELECT COUNT(*) FROM challenge_members m WHERE m.challenge_id=challenges.id) members
     FROM challenges WHERE ${team?'id=?':'invite_code=?'}`).get(team?team.challenge_id:code);
   if(!c)return send(res,404,{error:'That invite link has expired or the code was not recognised'});
   const out={code,type:team?'team':'challenge',challenge:c,team:team?{id:team.id,name:team.name,image_url:team.image_url,members:team.members}:null};
   if(u){out.member=!!challengeAccess(u.id,c.id);out.inTeam=team?!!db.prepare('SELECT 1 FROM team_members WHERE team_id=? AND user_id=?').get(team.id,u.id):null}
   return send(res,200,out);
 }
 if(m==='POST'&&url.pathname==='/api/join'){if(!need(res,u))return;const b=await body(req),code=String(b.code||'').trim().toUpperCase();if(!code)return send(res,400,{error:'Invite code required'});const challenge=db.prepare('SELECT * FROM challenges WHERE invite_code=?').get(code);if(challenge){db.prepare("INSERT OR IGNORE INTO challenge_members(challenge_id,user_id,challenge_role) VALUES(?,?,'member')").run(challenge.id,u.id);return send(res,200,{ok:true,type:'challenge',challengeId:challenge.id,name:challenge.name})}const team=db.prepare('SELECT * FROM teams WHERE invite_code=?').get(code);if(team){db.prepare("INSERT OR IGNORE INTO challenge_members(challenge_id,user_id,challenge_role) VALUES(?,?,'member')").run(team.challenge_id,u.id);db.prepare("INSERT OR IGNORE INTO team_members(team_id,user_id,team_role) VALUES(?,?,'member')").run(team.id,u.id);return send(res,200,{ok:true,type:'team',challengeId:team.challenge_id,teamId:team.id,name:team.name})}return send(res,400,{error:'That invite code was not recognised'})}

 if(m==='POST'&&url.pathname==='/api/teams'){if(!need(res,u))return;const b=await body(req),cid=Number(b.challenge_id);if(!b.name||!cid)return send(res,400,{error:'challenge_id and name are required'});if(!challengeAccess(u.id,cid))return send(res,403,{error:'Join the challenge before creating a team in it'});if(isIndividual(db.prepare('SELECT participation FROM challenges WHERE id=?').get(cid)))return send(res,400,{error:'This challenge is for individuals - it has no teams'});let imageUrl;try{imageUrl=validateImageUrl(b.image_url)}catch(e){return send(res,400,{error:e.message})}const {id,invite_code}=insertTeam(cid,String(b.name).trim(),u.id,imageUrl||null);return send(res,201,{id,invite_code})}
 if(m==='POST'&&url.pathname.match(/^\/api\/teams\/\d+\/join$/)){if(!need(res,u))return;const tid=Number(url.pathname.split('/')[3]),team=db.prepare('SELECT * FROM teams WHERE id=?').get(tid);if(!team)return send(res,404,{error:'Team not found'});if(!challengeAccess(u.id,team.challenge_id))return send(res,403,{error:'Join the challenge before joining one of its teams'});db.prepare("INSERT OR IGNORE INTO team_members(team_id,user_id,team_role) VALUES(?,?,'member')").run(tid,u.id);return send(res,200,{ok:true})}
 if(m==='PATCH'&&url.pathname.match(/^\/api\/teams\/\d+$/)){if(!need(res,u))return;const tid=Number(url.pathname.split('/')[3]),team=db.prepare('SELECT * FROM teams WHERE id=?').get(tid);if(!team)return send(res,404,{error:'Team not found'});if(!canManageTeam(u,team))return send(res,403,{error:'Only a team admin or the challenge owner can rename this team'});const b=await body(req),name=String(b.name||'').trim();if(!name)return send(res,400,{error:'Name is required'});let imageUrl;try{imageUrl=validateImageUrl(b.image_url)}catch(e){return send(res,400,{error:e.message})}if(imageUrl!==undefined)db.prepare('UPDATE teams SET name=?,image_url=? WHERE id=?').run(name,imageUrl,tid);else db.prepare('UPDATE teams SET name=? WHERE id=?').run(name,tid);return send(res,200,{ok:true})}
 if(m==='DELETE'&&url.pathname.match(/^\/api\/teams\/\d+$/)){if(!need(res,u))return;const tid=Number(url.pathname.split('/')[3]),team=db.prepare('SELECT * FROM teams WHERE id=?').get(tid);if(!team)return send(res,404,{error:'Team not found'});if(!canManageTeam(u,team))return send(res,403,{error:'Only a team admin or the challenge owner can delete this team'});try{db.exec('BEGIN');db.prepare('DELETE FROM activities WHERE team_id=?').run(tid);db.prepare('DELETE FROM teams WHERE id=?').run(tid);db.exec('COMMIT')}catch(e){db.exec('ROLLBACK');throw e}pruneRoutes();return send(res,200,{ok:true})}
 // Leave a team you're in. What you logged under it stays on its total, as when a team admin removes someone.
 if(m==='POST'&&url.pathname.match(/^\/api\/teams\/\d+\/leave$/)){
   if(!need(res,u))return;
   const tid=Number(url.pathname.split('/')[3]);
   if(!db.prepare('DELETE FROM team_members WHERE team_id=? AND user_id=?').run(tid,u.id).changes)return send(res,400,{error:"You're not in this team"});
   return send(res,200,{ok:true});
 }
 if(m==='GET'&&url.pathname.match(/^\/api\/teams\/\d+\/members$/)){if(!need(res,u))return;const tid=Number(url.pathname.split('/')[3]),team=db.prepare('SELECT * FROM teams WHERE id=?').get(tid);if(!team)return send(res,404,{error:'Team not found'});const manage=canManageTeam(u,team);if(!teamAccess(u.id,tid)&&!manage)return send(res,403,{error:'You need to be in this team to view its members'});const members=db.prepare('SELECT u.id,u.name,u.email,tm.team_role FROM team_members tm JOIN users u ON u.id=tm.user_id WHERE tm.team_id=? ORDER BY u.name').all(tid);return send(res,200,{members,canManage:manage})}
 if(m==='POST'&&url.pathname.match(/^\/api\/teams\/\d+\/members$/)){if(!need(res,u))return;const tid=Number(url.pathname.split('/')[3]),team=db.prepare('SELECT * FROM teams WHERE id=?').get(tid);if(!team)return send(res,404,{error:'Team not found'});if(!canManageTeam(u,team))return send(res,403,{error:'Only a team admin or the challenge owner can add members'});const b=await body(req),email=String(b.email||'').toLowerCase().trim();if(!email)return send(res,400,{error:'Email is required'});const found=db.prepare('SELECT id,name,email FROM users WHERE email=?').get(email);if(!found)return send(res,404,{error:'No account found for that email. Ask them to register first, or share the invite code instead.'});db.prepare("INSERT OR IGNORE INTO challenge_members(challenge_id,user_id,challenge_role) VALUES(?,?,'member')").run(team.challenge_id,found.id);db.prepare("INSERT OR IGNORE INTO team_members(team_id,user_id,team_role) VALUES(?,?,'member')").run(tid,found.id);return send(res,201,{ok:true,user:found})}
 if(m==='DELETE'&&url.pathname.match(/^\/api\/teams\/\d+\/members\/\d+$/)){if(!need(res,u))return;const parts=url.pathname.split('/'),tid=Number(parts[3]),targetId=Number(parts[5]),team=db.prepare('SELECT * FROM teams WHERE id=?').get(tid);if(!team)return send(res,404,{error:'Team not found'});if(!canManageTeam(u,team))return send(res,403,{error:'Only a team admin or the challenge owner can remove members'});db.prepare('DELETE FROM team_members WHERE team_id=? AND user_id=?').run(tid,targetId);return send(res,200,{ok:true})}
 if(m==='POST'&&url.pathname.match(/^\/api\/teams\/\d+\/invite$/)){if(!need(res,u))return;const tid=Number(url.pathname.split('/')[3]),ta=teamAccess(u.id,tid);if(u.role!=='global_admin'&&ta?.team_role!=='team_admin')return send(res,403,{error:'Team admin required'});const b=await body(req),token=crypto.randomBytes(24).toString('hex'),exp=new Date(Date.now()+7*864e5).toISOString();db.prepare('INSERT INTO invites(team_id,email,token,team_role,expires_at,created_by) VALUES(?,?,?,?,?,?)').run(tid,String(b.email).toLowerCase(),token,b.team_role||'member',exp,u.id);return send(res,201,{inviteUrl:`${ORIGIN}/?invite=${token}`,expiresAt:exp})}
 if(m==='POST'&&url.pathname==='/api/invites/accept'){if(!need(res,u))return;const b=await body(req),inv=db.prepare("SELECT * FROM invites WHERE token=? AND accepted_at IS NULL AND expires_at>datetime('now')").get(b.token);if(!inv)return send(res,400,{error:'Invite invalid or expired'});if(inv.email!==u.email)return send(res,403,{error:'This invite was issued to another email address'});const team=db.prepare('SELECT challenge_id FROM teams WHERE id=?').get(inv.team_id);db.prepare("INSERT OR IGNORE INTO challenge_members(challenge_id,user_id,challenge_role) VALUES(?,?,'member')").run(team.challenge_id,u.id);db.prepare('INSERT OR REPLACE INTO team_members(team_id,user_id,team_role) VALUES(?,?,?)').run(inv.team_id,u.id,inv.team_role);db.prepare("UPDATE invites SET accepted_at=datetime('now') WHERE id=?").run(inv.id);return send(res,200,{ok:true,challengeId:team.challenge_id,teamId:inv.team_id})}

 // Someone's profile, as a challenge-mate sees it - also how you preview your own. Only people who
 // share at least one challenge can see each other (else 404, as if they didn't exist); a global
 // admin can see anyone. Only shared challenges are listed, never others the person is in; what
 // appears beyond name and photo follows their profile_sharing. Routes are never included.
 if(m==='GET'&&url.pathname.match(/^\/api\/users\/\d+\/profile$/)){
   if(!need(res,u))return;
   const id=Number(url.pathname.split('/')[3]);
   const target=db.prepare('SELECT id,name,avatar_url,bio,profile_sharing,created_at FROM users WHERE id=?').get(id);
   if(!target)return send(res,404,{error:'Not found'});
   const self=target.id===u.id;
   const shared=self||u.role==='global_admin'
     ?db.prepare('SELECT c.* FROM challenges c JOIN challenge_members cm ON cm.challenge_id=c.id WHERE cm.user_id=? ORDER BY c.start_date DESC').all(id)
     :db.prepare('SELECT c.* FROM challenges c JOIN challenge_members a ON a.challenge_id=c.id AND a.user_id=? JOIN challenge_members b ON b.challenge_id=c.id AND b.user_id=? ORDER BY c.start_date DESC').all(id,u.id);
   if(!self&&u.role!=='global_admin'&&!shared.length)return send(res,404,{error:'Not found'});
   const sharing=PROFILE_SHARING.includes(target.profile_sharing)?target.profile_sharing:'summary';
   const out={id:target.id,name:target.name,avatar_url:target.avatar_url,bio:target.bio||null,member_since:String(target.created_at||'').slice(0,10),sharing,self};
   if(sharing!=='private'){
     out.challenges=shared.map(c=>{
       const lb=leaderboard(c),i=lb.users.findIndex(x=>x.id===id),me=lb.users[i]||{minutes:0,distance:0,steps:0};
       const team=db.prepare('SELECT t.name FROM teams t JOIN team_members tm ON tm.team_id=t.id WHERE tm.user_id=? AND t.challenge_id=? ORDER BY t.name LIMIT 1').get(id,c.id);
       return {id:c.id,name:c.name,start_date:c.start_date,end_date:c.end_date,metric:challengeMetric(c),distance_unit:challengeUnit(c),participation:isIndividual(c)?'individual':'teams',
         team:team?team.name:null,minutes:me.minutes,distance:me.distance,steps:me.steps,rank:i+1,of:lb.users.length};
     });
   }
   if(sharing==='full'&&shared.length){
     const ids=shared.map(c=>c.id);
     out.activities=db.prepare(`SELECT a.activity_type,a.minutes,a.distance_m,a.steps,a.activity_date,a.start_time,a.comment,c.name challenge_name,c.metric,c.distance_unit FROM activities a JOIN challenges c ON c.id=a.challenge_id WHERE a.user_id=? AND a.challenge_id IN (${ids.map(()=>'?').join(',')}) ORDER BY a.activity_date DESC,a.start_time DESC,a.id DESC LIMIT 30`)
       .all(id,...ids).map(({distance_m,...a})=>({...a,distance:distance_m==null?null:metersToUnit(distance_m,a.distance_unit)}));
   }
   // Followers and following: counts for anyone who can see the profile. The lists only name people
   // the viewer could see anyway (themselves or a challenge-mate), and a private profile shows none.
   const followPeople=col=>db.prepare(`SELECT us.id,us.name,us.avatar_url FROM follows f JOIN users us ON us.id=f.${col==='followers'?'follower_id':'followee_id'}
     WHERE f.${col==='followers'?'followee_id':'follower_id'}=? AND us.deactivated_at IS NULL ORDER BY us.name`).all(id);
   const followers=followPeople('followers'),following=followPeople('following');
   const seen=x=>self||u.role==='global_admin'||x.id===u.id||sharesChallenge(u.id,x.id);
   Object.assign(out,{followers_count:followers.length,following_count:following.length,
     is_following:!self&&!!db.prepare('SELECT 1 FROM follows WHERE follower_id=? AND followee_id=?').get(u.id,id),
     follows_you:!self&&!!db.prepare('SELECT 1 FROM follows WHERE follower_id=? AND followee_id=?').get(id,u.id)});
   if(self||sharing!=='private'){out.followers=followers.filter(seen);out.following=following.filter(seen)}
   return send(res,200,out);
 }
 // Follow someone whose profile you can see (a challenge-mate; global admins anyone). Unfollowing always works.
 if((m==='POST'||m==='DELETE')&&url.pathname.match(/^\/api\/users\/\d+\/follow$/)){
   if(!need(res,u))return;
   const id=Number(url.pathname.split('/')[3]);
   if(m==='DELETE'){db.prepare('DELETE FROM follows WHERE follower_id=? AND followee_id=?').run(u.id,id);return send(res,200,{ok:true,following:false})}
   if(id===u.id)return send(res,400,{error:"You can't follow yourself"});
   if(!db.prepare('SELECT 1 FROM users WHERE id=? AND deactivated_at IS NULL').get(id)||(u.role!=='global_admin'&&!sharesChallenge(u.id,id)))return send(res,404,{error:'Not found'});
   db.prepare('INSERT OR IGNORE INTO follows(follower_id,followee_id) VALUES(?,?)').run(u.id,id);
   return send(res,200,{ok:true,following:true});
 }
 // One activity into one challenge (challenge_id + team_id, as before) or into several at once
 // (targets: [{challenge_id, team_id?}, ...]) - one entry per challenge, all or none, sharing one
 // stored route if a GPX route came with it.
 if(m==='POST'&&url.pathname==='/api/activities'){
   if(!need(res,u))return;
   let b;
   try{b=await body(req,ROUTE_BODY_MAX)}catch(e){return send(res,413,{error:'That route is too large to upload'})}
   const rawTargets=Array.isArray(b.targets)&&b.targets.length?b.targets:[{challenge_id:b.challenge_id,team_id:b.team_id}];
   if(rawTargets.length>50)return send(res,400,{error:'Too many challenges at once'});
   const rows=[];
   for(const t of rawTargets){
     const challengeId=Number(t.challenge_id),challenge=db.prepare('SELECT * FROM challenges WHERE id=?').get(challengeId);
     const target=activityTarget(u,challenge,t.team_id);
     if(target.error)return send(res,target.status,{error:rawTargets.length>1&&challenge?`${challenge.name}: ${target.error}`:target.error});
     let times,minutes,distance_m,steps;
     try{requireInWindow(challenge,b.activity_date);times=validateTimes(b.start_time,b.end_time);minutes=parseMinutes(b.minutes)??null;distance_m=parseDistance(b,challengeUnit(challenge))??null;steps=parseSteps(b.steps)??null;requireMeasure(challenge,minutes,distance_m,steps,b.activity_type)}
     catch(e){return send(res,400,{error:rawTargets.length>1?`${challenge.name}: ${e.message}`:e.message})}
     rows.push({challengeId,teamId:target.teamId,times,minutes,distance_m,steps});
   }
   let route;
   try{route=parseRoute(b.route)}catch(e){return send(res,400,{error:e.message})}
   const comment=b.comment!==undefined?(String(b.comment).trim().slice(0,500)||null):null;
   const source=b.source||'manual',sourceRef=b.source_ref||(route?'gpx-'+crypto.randomUUID():null);
   try{
     db.exec('BEGIN');
     const routeId=route?saveRoute(u.id,source,sourceRef,route):null;
     const ins=db.prepare('INSERT INTO activities(user_id,team_id,challenge_id,activity_type,minutes,distance_m,steps,activity_date,source,source_ref,start_time,end_time,comment,route_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
     for(const r of rows)ins.run(u.id,r.teamId,r.challengeId,b.activity_type,r.minutes,r.distance_m,r.steps,b.activity_date,source,sourceRef,r.times.start_time,r.times.end_time,comment,routeId);
     db.exec('COMMIT');
   }catch(e){db.exec('ROLLBACK');return send(res,400,{error:'Invalid or duplicate activity'})}
   return send(res,201,{ok:true,created:rows.length});
 }
 // Everything this user has logged, newest first, across every challenge - the companion's
 // "My activity" list. Paged; has_route says whether a map can be shown.
 if(m==='GET'&&url.pathname==='/api/me/activities'){
   if(!need(res,u))return;
   const limit=Math.min(Math.max(Number(url.searchParams.get('limit'))||50,1),200),offset=Math.max(Number(url.searchParams.get('offset'))||0,0);
   const rows=db.prepare(`SELECT a.id,a.challenge_id,a.team_id,a.activity_type,a.minutes,a.distance_m,a.steps,a.activity_date,a.start_time,a.end_time,a.comment,a.source,a.route_id,t.name team_name,c.name challenge_name,c.metric,c.distance_unit FROM activities a LEFT JOIN teams t ON t.id=a.team_id JOIN challenges c ON c.id=a.challenge_id WHERE a.user_id=? ORDER BY a.activity_date DESC,a.start_time DESC,a.id DESC LIMIT ? OFFSET ?`).all(u.id,limit+1,offset);
   const more=rows.length>limit;
   const activities=rows.slice(0,limit).map(({route_id,...a})=>({...a,distance:a.distance_m==null?null:metersToUnit(a.distance_m,a.distance_unit),has_route:route_id!=null}));
   return send(res,200,{activities,more});
 }
 // A route is personal location data: only the person who logged the activity can fetch it.
 if(m==='GET'&&url.pathname.match(/^\/api\/activities\/\d+\/route$/)){
   if(!need(res,u))return;
   const id=Number(url.pathname.split('/')[3]),a=db.prepare('SELECT user_id,route_id FROM activities WHERE id=?').get(id);
   if(!a||a.user_id!==u.id)return send(res,404,{error:'Not found'});
   if(!a.route_id)return send(res,404,{error:'This activity has no route'});
   const r=db.prepare('SELECT points FROM routes WHERE id=?').get(a.route_id);
   return send(res,200,{points:JSON.parse(r.points)});
 }
 // Only the person who logged an entry may edit or delete it - team_id/challenge_id are
 // intentionally not editable here, so "fixing" an entry never re-attributes it elsewhere.
 if(m==='PATCH'&&url.pathname.match(/^\/api\/activities\/\d+$/)){
   if(!need(res,u))return;
   const id=Number(url.pathname.split('/')[3]),existing=db.prepare('SELECT * FROM activities WHERE id=?').get(id);
   if(!existing)return send(res,404,{error:'Activity not found'});
   if(existing.user_id!==u.id)return send(res,403,{error:'You can only edit your own activity'});
   const b=await body(req);
   const activity_type=b.activity_type!==undefined?String(b.activity_type).trim():existing.activity_type;
   const challenge=db.prepare('SELECT * FROM challenges WHERE id=?').get(existing.challenge_id);
   let minutes,distance_m,steps;
   try{minutes=parseMinutes(b.minutes);distance_m=parseDistance(b,challengeUnit(challenge));steps=parseSteps(b.steps)}catch(e){return send(res,400,{error:e.message})}
   if(minutes===undefined)minutes=existing.minutes;
   if(distance_m===undefined)distance_m=existing.distance_m;
   if(steps===undefined)steps=existing.steps;
   const activity_date=b.activity_date!==undefined?b.activity_date:existing.activity_date;
   const start_time=b.start_time!==undefined?b.start_time:existing.start_time;
   const end_time=b.end_time!==undefined?b.end_time:existing.end_time;
   const comment=b.comment!==undefined?(String(b.comment).trim().slice(0,500)||null):existing.comment;
   if(!activity_type||!activity_date)return send(res,400,{error:'Invalid activity fields'});
   let times;
   try{if(b.activity_date!==undefined)requireInWindow(challenge,activity_date);times=validateTimes(start_time,end_time);requireMeasure(challenge,minutes,distance_m,steps,activity_type)}catch(e){return send(res,400,{error:e.message})}
   db.prepare('UPDATE activities SET activity_type=?,minutes=?,distance_m=?,steps=?,activity_date=?,start_time=?,end_time=?,comment=? WHERE id=?').run(activity_type,minutes,distance_m,steps,activity_date,times.start_time,times.end_time,comment,id);
   return send(res,200,{ok:true});
 }
 if(m==='DELETE'&&url.pathname.match(/^\/api\/activities\/\d+$/)){
   if(!need(res,u))return;
   const id=Number(url.pathname.split('/')[3]),existing=db.prepare('SELECT * FROM activities WHERE id=?').get(id);
   if(!existing)return send(res,404,{error:'Activity not found'});
   if(existing.user_id!==u.id)return send(res,403,{error:'You can only delete your own activity'});
   db.prepare('DELETE FROM activities WHERE id=?').run(id);
   pruneRoutes();
   return send(res,200,{ok:true});
 }

 // Report a bug, request a feature or ask a question.
 if(m==='POST'&&url.pathname==='/api/tickets'){
   if(!need(res,u))return;
   if(hitRateLimit('ticket:'+u.id,TICKET_RATE_MAX,TICKET_RATE_WINDOW_MS))return send(res,429,{error:'That is a lot of tickets in an hour - please add to an existing one instead.'});
   const b=await body(req);
   const type=TICKET_TYPES.includes(b.type)?b.type:null,title=String(b.title||'').trim().slice(0,120),description=String(b.description||'').trim().slice(0,5000);
   if(!type)return send(res,400,{error:'type must be bug, feature or question'});
   if(!title||!description)return send(res,400,{error:'A title and a description are required'});
   let image;try{image=validateImageUrl(b.image_url)??null}catch(e){return send(res,400,{error:e.message})}
   const info=b.client_info?String(b.client_info).slice(0,300):null;
   const r=db.prepare('INSERT INTO tickets(user_id,type,title,description,image_url,client_info) VALUES(?,?,?,?,?,?)').run(u.id,type,title,description,image,info);
   return send(res,201,{id:Number(r.lastInsertRowid)});
 }
 // My tickets, or (admins, scope=all) everyone's, newest activity first, with optional filters.
 if(m==='GET'&&url.pathname==='/api/tickets'){
   if(!need(res,u))return;
   const all=url.searchParams.get('scope')==='all';
   if(all&&!isAdmin(u))return send(res,403,{error:'Admins only'});
   const where=[],params=[];
   if(!all){where.push('t.user_id=?');params.push(u.id)}
   const st=url.searchParams.get('status'),ty=url.searchParams.get('type');
   if(st==='open'){where.push("t.status IN ('new','in_progress','planned')")}else if(TICKET_STATUSES.includes(st)){where.push('t.status=?');params.push(st)}
   if(TICKET_TYPES.includes(ty)){where.push('t.type=?');params.push(ty)}
   const rows=db.prepare(`${TICKET_SELECT}${where.length?' WHERE '+where.join(' AND '):''} ORDER BY t.updated_at DESC,t.id DESC LIMIT 200`).all(...params);
   const tickets=rows.map(t=>ticketView(t,u));
   const out={tickets,unread:tickets.filter(t=>t.unread).length};
   if(all){
     out.counts=Object.fromEntries(TICKET_STATUSES.map(s=>[s,0]));
     for(const r of db.prepare('SELECT status,COUNT(*) n FROM tickets GROUP BY status').all())out.counts[r.status]=r.n;
     out.byType=Object.fromEntries(TICKET_TYPES.map(s=>[s,0]));
     for(const r of db.prepare("SELECT type,COUNT(*) n FROM tickets WHERE status IN ('new','in_progress','planned') GROUP BY type").all())out.byType[r.type]=r.n;
   }
   return send(res,200,out);
 }
 // How many of my tickets have an unread reply - for the Help badge. Admins also get new/unread ones.
 if(m==='GET'&&url.pathname==='/api/tickets/badge'){
   if(!need(res,u))return;
   const mine=db.prepare('SELECT COUNT(*) n FROM tickets WHERE user_id=? AND last_reply_at IS NOT NULL AND (owner_seen_at IS NULL OR last_reply_at>owner_seen_at)').get(u.id).n;
   const admin=isAdmin(u)?db.prepare('SELECT COUNT(*) n FROM tickets WHERE user_id<>? AND (admin_seen_at IS NULL OR last_user_reply_at>admin_seen_at)').get(u.id).n:0;
   return send(res,200,{mine,admin});
 }
 // One ticket and its conversation. Opening it marks it seen for that side.
 if(m==='GET'&&url.pathname.match(/^\/api\/tickets\/\d+$/)){
   if(!need(res,u))return;
   const id=Number(url.pathname.split('/')[3]),t=db.prepare(`${TICKET_SELECT} WHERE t.id=?`).get(id);
   if(!t||(t.user_id!==u.id&&!isAdmin(u)))return send(res,404,{error:'Not found'});
   const view=ticketView(t,u);
   const comments=db.prepare(`SELECT c.id,c.body,c.internal,c.created_at,c.user_id,u.name,u.avatar_url,u.role FROM ticket_comments c JOIN users u ON u.id=c.user_id WHERE c.ticket_id=?${isAdmin(u)?'':' AND c.internal=0'} ORDER BY c.id`).all(id)
     .map(c=>({id:c.id,body:c.body,internal:!!c.internal,created_at:c.created_at,author:{id:c.user_id,name:c.name,avatar_url:c.avatar_url||null},from_support:c.role==='global_admin'&&c.user_id!==t.user_id}));
   if(t.user_id===u.id)db.prepare('UPDATE tickets SET owner_seen_at=? WHERE id=?').run(nowIso(),id);
   if(isAdmin(u)&&t.user_id!==u.id)db.prepare('UPDATE tickets SET admin_seen_at=? WHERE id=?').run(nowIso(),id);
   return send(res,200,{...view,comments});
 }
 // Reply: the reporter on their own ticket, or an admin (optionally as an internal note).
 if(m==='POST'&&url.pathname.match(/^\/api\/tickets\/\d+\/comments$/)){
   if(!need(res,u))return;
   const id=Number(url.pathname.split('/')[3]),t=db.prepare('SELECT * FROM tickets WHERE id=?').get(id);
   if(!t||(t.user_id!==u.id&&!isAdmin(u)))return send(res,404,{error:'Not found'});
   const b=await body(req),text=String(b.body||'').trim().slice(0,5000);
   if(!text)return send(res,400,{error:'Write something first'});
   const internal=isAdmin(u)&&!!b.internal;
   db.prepare('INSERT INTO ticket_comments(ticket_id,user_id,body,internal) VALUES(?,?,?,?)').run(id,u.id,text,internal?1:0);
   const at=nowIso();
   if(internal)db.prepare('UPDATE tickets SET updated_at=?,admin_seen_at=? WHERE id=?').run(at,at,id);
   else if(t.user_id===u.id)db.prepare('UPDATE tickets SET updated_at=?,last_user_reply_at=?,owner_seen_at=? WHERE id=?').run(at,at,at,id);
   else db.prepare('UPDATE tickets SET updated_at=?,last_reply_at=?,admin_seen_at=? WHERE id=?').run(at,at,at,id);
   return send(res,201,{ok:true});
 }
 // Admins set the status and the outcome the reporter sees.
 if(m==='PATCH'&&url.pathname.match(/^\/api\/tickets\/\d+$/)){
   if(!need(res,u,['global_admin']))return;
   const id=Number(url.pathname.split('/')[3]),t=db.prepare('SELECT * FROM tickets WHERE id=?').get(id);
   if(!t)return send(res,404,{error:'Not found'});
   const b=await body(req);
   const status=b.status!==undefined?b.status:t.status;
   if(!TICKET_STATUSES.includes(status))return send(res,400,{error:'status must be one of '+TICKET_STATUSES.join(', ')});
   const resolution=b.resolution!==undefined?(String(b.resolution).trim().slice(0,2000)||null):t.resolution;
   const changed=status!==t.status||resolution!==t.resolution;
   if(!changed)return send(res,200,{ok:true});
   const at=nowIso();
   // A status or outcome change is news to the reporter, like a reply.
   db.prepare('UPDATE tickets SET status=?,resolution=?,updated_at=?,last_reply_at=?,admin_seen_at=? WHERE id=?').run(status,resolution,at,at,at,id);
   return send(res,200,{ok:true});
 }
 // Global admins: every user, with how involved they are.
 if(m==='GET'&&url.pathname==='/api/admin/users'){if(!need(res,u,['global_admin']))return;return send(res,200,{users:db.prepare(`SELECT us.id,us.email,us.name,us.role,us.created_at,us.avatar_url,us.deactivated_at,
   (SELECT COUNT(*) FROM challenge_members cm WHERE cm.user_id=us.id) challenges,
   (SELECT COUNT(*) FROM activities a WHERE a.user_id=us.id) activities,
   (SELECT MAX(a.activity_date) FROM activities a WHERE a.user_id=us.id) last_activity,
   (SELECT COUNT(*) FROM tickets t WHERE t.user_id=us.id) tickets
   FROM users us ORDER BY us.name`).all()})}
 // Global admins: every challenge, whether or not they're in it.
 if(m==='GET'&&url.pathname==='/api/admin/challenges'){
   if(!need(res,u,['global_admin']))return;
   const rows=db.prepare(`SELECT c.id,c.name,c.start_date,c.end_date,c.metric,c.distance_unit,c.participation,c.invite_code,c.created_at,
     cr.name creator_name,
     (SELECT group_concat(us.name,', ') FROM challenge_members cm JOIN users us ON us.id=cm.user_id WHERE cm.challenge_id=c.id AND cm.challenge_role='owner') owners,
     (SELECT COUNT(*) FROM challenge_members cm WHERE cm.challenge_id=c.id) members,
     (SELECT COUNT(*) FROM teams t WHERE t.challenge_id=c.id) teams,
     (SELECT COUNT(*) FROM activities a WHERE a.challenge_id=c.id) activities,
     (SELECT MAX(a.activity_date) FROM activities a WHERE a.challenge_id=c.id) last_activity
     FROM challenges c LEFT JOIN users cr ON cr.id=c.created_by ORDER BY c.end_date DESC,c.name`).all();
   const today=new Date().toISOString().slice(0,10);
   return send(res,200,{challenges:rows.map(r=>({...r,state:today<r.start_date?'upcoming':today>r.end_date?'finished':'running',
     purge_date:new Date(Date.parse(r.end_date+'T00:00:00Z')+61*864e5).toISOString().slice(0,10)}))});
 }
 if(m==='POST'&&url.pathname==='/api/admin/users'){if(!need(res,u,['global_admin']))return;const b=await body(req);try{const r=db.prepare('INSERT INTO users(email,name,password_hash,role) VALUES(?,?,?,?)').run(String(b.email).toLowerCase(),b.name,hash(b.password),b.role||'member');return send(res,201,{id:Number(r.lastInsertRowid)})}catch(e){return send(res,400,{error:'Email already exists or fields are invalid'})}}
 if(m==='PATCH'&&url.pathname.match(/^\/api\/admin\/users\/\d+$/)){
   if(!need(res,u,['global_admin']))return;
   const id=Number(url.pathname.split('/').pop()),b=await body(req),target=db.prepare('SELECT id,role,deactivated_at FROM users WHERE id=?').get(id);
   if(!target)return send(res,404,{error:'User not found'});
   const deactivating=b.active===false&&!target.deactivated_at,demoting=b.role!==undefined&&b.role!=='global_admin';
   if(deactivating||(demoting&&target.role==='global_admin')){const err=adminUserChangeError(u,target,{removesAdmin:true});if(err)return send(res,400,{error:err})}
   if(b.role!==undefined&&!['member','global_admin'].includes(b.role))return send(res,400,{error:'Unknown role'});
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
   if(b.active!==undefined)db.prepare('UPDATE users SET deactivated_at=? WHERE id=?').run(b.active?null:(target.deactivated_at||nowIso()),id);
   // A new password or deactivation ends every session that account has open.
   if(passwordHash||deactivating)db.prepare('DELETE FROM sessions WHERE user_id=?').run(id);
   return send(res,200,{ok:true})
 }
 // Delete an account for good: its activity and routes, memberships and tickets go with it.
 // Challenges and teams it created stay (other people are in them), credited to the admin doing the delete.
 // Delete my own account, confirmed with my password - both app stores require this in the app. The
 // same clean-up as an admin deletion; a challenge I own alone passes to its longest-standing member,
 // or is deleted with me if nobody else is in it.
 if((m==='DELETE'&&url.pathname==='/api/me')||(m==='POST'&&url.pathname==='/api/me/delete')){
   if(!need(res,u))return;
   const b=await body(req),row=db.prepare('SELECT password_hash FROM users WHERE id=?').get(u.id);
   if(!b.password||!verify(String(b.password),row.password_hash))return send(res,400,{error:'Enter your current password to delete your account'});
   if(u.email===seedEmail)return send(res,400,{error:"This is the site's built-in admin account from the server settings - it can't be deleted."});
   const heir=db.prepare("SELECT id FROM users WHERE role='global_admin' AND deactivated_at IS NULL AND id!=? ORDER BY id LIMIT 1").get(u.id);
   if(!heir)return send(res,400,{error:"You're the only global admin - make someone else an admin first"});
   try{
     db.exec('BEGIN');
     const solo=db.prepare(`SELECT challenge_id FROM challenge_members cm WHERE cm.user_id=? AND cm.challenge_role='owner'
       AND NOT EXISTS (SELECT 1 FROM challenge_members o WHERE o.challenge_id=cm.challenge_id AND o.challenge_role='owner' AND o.user_id!=?)`).all(u.id,u.id);
     for(const {challenge_id:cid} of solo){
       const next=db.prepare('SELECT user_id FROM challenge_members WHERE challenge_id=? AND user_id!=? ORDER BY joined_at,user_id LIMIT 1').get(cid,u.id);
       if(next)db.prepare("UPDATE challenge_members SET challenge_role='owner' WHERE challenge_id=? AND user_id=?").run(cid,next.user_id);
       else{db.prepare('DELETE FROM activities WHERE challenge_id=?').run(cid);db.prepare('DELETE FROM challenges WHERE id=?').run(cid)}
     }
     db.prepare('DELETE FROM activities WHERE user_id=?').run(u.id);
     db.prepare('UPDATE challenges SET created_by=? WHERE created_by=?').run(heir.id,u.id);
     db.prepare('UPDATE teams SET created_by=? WHERE created_by=?').run(heir.id,u.id);
     db.prepare('UPDATE invites SET created_by=? WHERE created_by=?').run(heir.id,u.id);
     db.prepare('DELETE FROM users WHERE id=?').run(u.id);
     db.exec('COMMIT');
   }catch(e){db.exec('ROLLBACK');throw e}
   pruneRoutes();
   console.log(`User ${u.id} deleted their own account`);
   return send(res,200,{ok:true},{'Set-Cookie':'session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0'});
 }
 if(m==='DELETE'&&url.pathname.match(/^\/api\/admin\/users\/\d+$/)){
   if(!need(res,u,['global_admin']))return;
   const id=Number(url.pathname.split('/').pop()),target=db.prepare('SELECT id,email,role,deactivated_at FROM users WHERE id=?').get(id);
   if(!target)return send(res,404,{error:'User not found'});
   const err=adminUserChangeError(u,target,{removesAdmin:true});if(err)return send(res,400,{error:err});
   if(target.email===seedEmail)return send(res,400,{error:'This is the built-in admin account from the server settings - it would be re-created on restart. Deactivate it instead.'});
   try{
     db.exec('BEGIN');
     db.prepare('DELETE FROM activities WHERE user_id=?').run(id);
     db.prepare('UPDATE challenges SET created_by=? WHERE created_by=?').run(u.id,id);
     db.prepare('UPDATE teams SET created_by=? WHERE created_by=?').run(u.id,id);
     db.prepare('UPDATE invites SET created_by=? WHERE created_by=?').run(u.id,id);
     db.prepare('DELETE FROM users WHERE id=?').run(id);
     db.exec('COMMIT');
   }catch(e){db.exec('ROLLBACK');throw e}
   pruneRoutes();
   return send(res,200,{ok:true});
 }

 if(m==='GET'&&url.pathname==='/api/health/status'){if(!need(res,u))return;return send(res,200,{healthConnect:{platform:'Android',mode:'native-companion-required'},healthKit:{platform:'iOS',mode:'native-companion-required'},acceptedRecord:'exercise session duration and distance',uploadEndpoint:'/api/health/import'})}
 // My Apple Shortcuts key: whether I have one, a new one (shown once, replacing any old one), or none.
 if(url.pathname==='/api/me/sync-key'&&['GET','POST','DELETE'].includes(m)){
   if(!need(res,u))return;
   if(m==='POST'){
     const key='at_'+crypto.randomBytes(20).toString('hex');
     db.prepare("UPDATE users SET sync_key_hash=?,sync_key_created_at=datetime('now') WHERE id=?").run(sha256hex(key),u.id);
     return send(res,201,{key});
   }
   if(m==='DELETE'){db.prepare('UPDATE users SET sync_key_hash=NULL,sync_key_created_at=NULL WHERE id=?').run(u.id);return send(res,200,{ok:true})}
   const r=db.prepare('SELECT sync_key_created_at FROM users WHERE id=?').get(u.id);
   return send(res,200,{exists:!!r.sync_key_created_at,created_at:r.sync_key_created_at});
 }
 // One day's totals from the Apple Shortcut: steps, exercise minutes, walking and running distance and
 // cycling distance, in one request or one per figure. Each figure is kept in shortcut_days, so one
 // not sent keeps its last value. The day's entry in every challenge I'm in that runs that day is
 // then worked out from them: a step challenge takes the steps, a minutes challenge the minutes, a
 // distance challenge walking plus cycling, an on-foot journey walking only, and a cycling journey
 // cycling only - under my first team in a team challenge. Sending a day again replaces it; an entry
 // left with nothing to count is removed.
 if(m==='POST'&&url.pathname==='/api/shortcut/day'){
   let b;try{b=await body(req)}catch(e){return send(res,400,{error:'Send the day as JSON'})}
   const key=String(req.headers['x-sync-key']||b.key||'').trim();
   const owner=key&&db.prepare('SELECT id,name FROM users WHERE sync_key_hash=? AND deactivated_at IS NULL').get(sha256hex(key));
   if(!owner)return send(res,401,{error:'That sync key is not recognised. Make a new one with Set up Apple Shortcuts on the activetogether.team home page.'});
   const date=String(b.date||'').trim();
   if(!DATE_RE.test(date))return send(res,400,{error:'date must be YYYY-MM-DD'});
   if(date>new Date(Date.now()+864e5).toISOString().slice(0,10))return send(res,400,{error:'That date is in the future'});
   // Shortcuts may send numbers as text, with thousands separators or decimals, and distances in
   // whatever unit the Health app uses. undefined = not sent this time.
   const num=v=>{if(v===undefined)return undefined;const n=Number(String(v??'').replace(/,/g,''));return Number.isFinite(n)&&n>0?n:0};
   const perUnit=v=>{const t=String(v||'mi').trim().toLowerCase();return /^(km|kilomet(er|re)s?)$/.test(t)?1000:/^(m|met(er|re)s?)$/.test(t)?1:/^(mi|miles?)$/.test(t)?METERS_PER.mi:null};
   const walkPer=perUnit(b.distance_unit),cyclePer=perUnit(b.cycling_unit||b.distance_unit);
   if(walkPer===null||cyclePer===null)return send(res,400,{error:'distance units must be mi, km or m'});
   const sent={steps:num(b.steps)===undefined?undefined:Math.round(num(b.steps)),minutes:num(b.minutes)===undefined?undefined:Math.round(num(b.minutes)),
     walk_m:num(b.distance)===undefined?undefined:num(b.distance)*walkPer,cycle_m:num(b.cycling_distance)===undefined?undefined:num(b.cycling_distance)*cyclePer};
   if(Object.values(sent).every(v=>v===undefined))return send(res,400,{error:'Send steps, minutes, distance or cycling_distance'});
   if(sent.steps>200000)return send(res,400,{error:'That is more steps than anyone walks in a day - check the shortcut'});
   const before=db.prepare('SELECT * FROM shortcut_days WHERE user_id=? AND day=?').get(owner.id,date)||{};
   const day={};for(const k of ['steps','minutes','walk_m','cycle_m'])day[k]=(sent[k]!==undefined?sent[k]:before[k])||0;
   db.prepare(`INSERT INTO shortcut_days(user_id,day,steps,minutes,walk_m,cycle_m) VALUES(?,?,?,?,?,?) ON CONFLICT(user_id,day) DO UPDATE SET
     steps=excluded.steps,minutes=excluded.minutes,walk_m=excluded.walk_m,cycle_m=excluded.cycle_m,updated_at=datetime('now')`).run(owner.id,date,day.steps,day.minutes,day.walk_m,day.cycle_m);
   const challenges=db.prepare('SELECT c.* FROM challenges c JOIN challenge_members cm ON cm.challenge_id=c.id WHERE cm.user_id=? AND c.start_date<=? AND c.end_date>=? ORDER BY c.name').all(owner.id,date,date);
   const saved=[],skipped=[],ref='day:'+date;
   for(const c of challenges){
     let teamId=null;
     if(!isIndividual(c)){
       const t=db.prepare('SELECT t.id FROM teams t JOIN team_members tm ON tm.team_id=t.id WHERE tm.user_id=? AND t.challenge_id=? ORDER BY t.id LIMIT 1').get(owner.id,c.id);
       if(!t){skipped.push(`${c.name}: join a team first`);continue}
       teamId=t.id;
     }
     const metric=challengeMetric(c);
     const row=metric==='steps'?{type:'Steps',steps:day.steps||null,minutes:null,distance_m:null}
       :isJourney(c)?(c.journey_mode==='cycling'?{type:'Cycling',steps:null,minutes:null,distance_m:day.cycle_m||null}:{type:'Walking & running',steps:null,minutes:null,distance_m:day.walk_m||null})
       :{type:'Daily activity',steps:null,minutes:day.minutes||null,distance_m:(day.walk_m+day.cycle_m)||null};
     const counts=metric==='steps'?row.steps:metric==='distance'?row.distance_m:row.minutes;
     const prev=db.prepare("SELECT id FROM activities WHERE user_id=? AND source='shortcut' AND source_ref=? AND challenge_id=?").get(owner.id,ref,c.id);
     if(!counts){if(prev)db.prepare('DELETE FROM activities WHERE id=?').run(prev.id);skipped.push(`${c.name}: nothing to count`);continue}
     if(prev)db.prepare('UPDATE activities SET team_id=?,activity_type=?,steps=?,minutes=?,distance_m=? WHERE id=?').run(teamId,row.type,row.steps,row.minutes,row.distance_m,prev.id);
     else db.prepare("INSERT INTO activities(user_id,team_id,challenge_id,activity_type,minutes,distance_m,steps,activity_date,source,source_ref) VALUES(?,?,?,?,?,?,?,?,'shortcut',?)")
       .run(owner.id,teamId,c.id,row.type,row.minutes,row.distance_m,row.steps,date,ref);
     saved.push(c.name);
   }
   // Each distance is echoed in the unit it came in (metres shown as km).
   const shown=(m,per)=>per===METERS_PER.mi?`${(m/per).toFixed(1)} mi`:`${(m/1000).toFixed(1)} km`;
   const figures=[sent.steps!==undefined&&`${sent.steps.toLocaleString('en-GB')} steps`,sent.minutes!==undefined&&`${sent.minutes} active min`,
     sent.walk_m!==undefined&&`${shown(sent.walk_m,walkPer)} on foot`,sent.cycle_m!==undefined&&`${shown(sent.cycle_m,cyclePer)} cycling`].filter(Boolean).join(', ');
   const message=saved.length?`${date}: ${figures} - saved to ${saved.join(', ')}`:`${date}: ${figures} - not saved (${skipped.join('; ')||'no challenge of yours runs that day'})`;
   return send(res,200,{ok:true,date,saved,skipped,message});
 }
 if(m==='POST'&&url.pathname==='/api/health/import'){
   if(!need(res,u))return;
   let b;
   try{b=await body(req,ROUTE_BODY_MAX)}catch(e){return send(res,413,{error:'Too much data in one upload - send fewer workouts at a time'})}
   if(!Array.isArray(b.records))return send(res,400,{error:'records array required'});
   if(!['health_connect','health_kit'].includes(b.source))return send(res,400,{error:'source must be health_connect or health_kit'});
   let added=0,skipped=0,updated=0;
   for(const x of b.records){
     const challengeId=Number(x.challenge_id),challenge=db.prepare('SELECT * FROM challenges WHERE id=?').get(challengeId);
     const target=activityTarget(u,challenge,x.team_id);
     if(target.error||!x.activity_date||!x.source_ref){skipped++;continue}
     const teamId=target.teamId;
     // Minutes stay whole numbers from a device, as before. Distance comes in metres. A record
     // without the challenge's own measure (a yoga session in a distance challenge) is skipped,
     // and counted as such, rather than stored as a zero.
     let minutes,distance_m,steps,route;
     try{
       route=parseRoute(x.route);
       minutes=parseMinutes(x.minutes)??null;
       if(minutes!==null&&!Number.isInteger(minutes))throw new Error('whole minutes only');
       distance_m=x.distance_m===undefined?null:parseDistance({distance_m:x.distance_m})??null;
       steps=parseSteps(x.steps)??null;
       requireMeasure(challenge,minutes,distance_m,steps,x.activity_type);
       requireInWindow(challenge,x.activity_date);
     }catch(e){skipped++;continue}
     // A day's step total keeps growing until midnight: sending the same day again replaces the
     // count already stored rather than being skipped as a duplicate.
     if(steps!==null&&minutes===null&&distance_m===null){
       const prev=db.prepare('SELECT id,steps FROM activities WHERE user_id=? AND source=? AND source_ref=? AND challenge_id=?').get(u.id,b.source,String(x.source_ref),challengeId);
       if(prev){if(prev.steps!==steps){db.prepare('UPDATE activities SET steps=? WHERE id=?').run(steps,prev.id);updated++}else skipped++;continue}
     }
     // Times here are best-effort device data, not direct user input: an inconsistent or
     // midnight-crossing pair just means "no times", not "reject the whole synced session".
     let times={start_time:null,end_time:null};try{times=validateTimes(x.start_time,x.end_time)}catch(e){}
     try{
       // A workout already synced into another challenge keeps its stored route, so a later record
       // for the same workout need not send the points again.
       const routeId=route?saveRoute(u.id,b.source,String(x.source_ref),route):(db.prepare('SELECT id FROM routes WHERE user_id=? AND source=? AND source_ref=?').get(u.id,b.source,String(x.source_ref))?.id??null);
       db.prepare('INSERT INTO activities(user_id,team_id,challenge_id,activity_type,minutes,distance_m,steps,activity_date,source,source_ref,start_time,end_time,route_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(u.id,teamId,challengeId,String(x.activity_type||'Synced activity').trim().slice(0,60)||'Synced activity',minutes,distance_m,steps,x.activity_date,b.source,x.source_ref,times.start_time,times.end_time,routeId);added++
     }catch(e){skipped++}
   }
   pruneRoutes();
   return send(res,200,{added,skipped,...(updated?{updated}:{})});
 }
 // Which of these device records this user has already synced, so the companion's review dialog
 // can show them as done rather than offering them again (a re-upload would be skipped anyway).
 if(m==='POST'&&url.pathname==='/api/health/synced'){
   if(!need(res,u))return;
   const b=await body(req);
   if(!['health_connect','health_kit'].includes(b.source))return send(res,400,{error:'source must be health_connect or health_kit'});
   const refs=Array.isArray(b.refs)?b.refs.map(String).slice(0,1000):[];
   // synced: refs in any challenge (as before); syncedIn: ref -> the challenge ids it is already in,
   // now that one workout can go into several.
   const q=db.prepare('SELECT challenge_id FROM activities WHERE user_id=? AND source=? AND source_ref=?');
   const syncedIn={};
   for(const r of refs){const ids=q.all(u.id,b.source,r).map(x=>x.challenge_id);if(ids.length)syncedIn[r]=ids}
   return send(res,200,{synced:Object.keys(syncedIn),syncedIn});
 }
 if(m==='GET'&&url.pathname==='/api/app/android'){if(!need(res,u))return;const r=androidRelease();return send(res,200,r?{available:true,version:r.version,versionCode:r.versionCode,size:r.size,published:r.published,sha256:r.sha256}:{available:false})}
 // The app can't hand its sign-in to the phone's browser, so it asks for a link that works on its own for 15 minutes.
 if(m==='GET'&&url.pathname==='/api/app/android/link'){if(!need(res,u))return;const dl=`/api/app/android/download?t=${downloadToken(Date.now()+15*60e3)}`;return send(res,200,{url:ORIGIN+dl,path:dl})}
 if(m==='GET'&&url.pathname==='/api/app/android/download'){
   if(!validDownloadToken(url.searchParams.get('t'))&&!need(res,u))return;
   const r=androidRelease();if(!r)return send(res,404,{error:'The Android app has not been published yet'});
   res.writeHead(200,{'Content-Type':'application/vnd.android.package-archive','Content-Length':r.size,'Cache-Control':'no-store',
     'Content-Disposition':`attachment; filename="ActiveTogether-${String(r.version).replace(/[^0-9A-Za-z.\-]/g,'')}.apk"`,'X-Content-Type-Options':'nosniff'});
   return fs.createReadStream(ANDROID_APK).pipe(res);
 }
 // The iPhone app: an .ipa for Sideloadly (no App Store), plus its version for the app's update notice.
 if(m==='GET'&&url.pathname==='/api/app/ios'){if(!need(res,u))return;const r=iosRelease();return send(res,200,r?{available:true,version:r.version,build:r.build,size:r.size,published:r.published}:{available:false})}
 if(m==='GET'&&url.pathname==='/api/app/ios/download'){
   if(!need(res,u))return;
   const r=iosRelease();if(!r)return send(res,404,{error:'The iPhone app has not been published yet'});
   res.writeHead(200,{'Content-Type':'application/octet-stream','Content-Length':r.size,'Cache-Control':'no-store',
     'Content-Disposition':`attachment; filename="ActiveTogether-${String(r.version).replace(/[^0-9A-Za-z.\-]/g,'')}.ipa"`,'X-Content-Type-Options':'nosniff'});
   return fs.createReadStream(IOS_IPA).pipe(res);
 }
 return send(res,404,{error:'Not found'});
}
// The Android app, published by tools/publish-android.sh onto the data volume (not baked into the
// image, so a new build needs no redeploy). Signed-in users only.
const DOWNLOADS_DIR=path.join(DATA,'downloads'),ANDROID_APK=path.join(DOWNLOADS_DIR,'ActiveTogether.apk'),ANDROID_INFO=path.join(DOWNLOADS_DIR,'android.json');
// Download links: expiry plus an HMAC under a per-process key (a restart just expires them early).
const DOWNLOAD_KEY=crypto.randomBytes(32);
const downloadSig=exp=>crypto.createHmac('sha256',DOWNLOAD_KEY).update('android:'+exp).digest('hex').slice(0,32);
const downloadToken=exp=>`${exp}.${downloadSig(exp)}`;
function validDownloadToken(t){
  const [exp,sig]=String(t||'').split('.');
  if(!exp||!sig||!(Number(exp)>Date.now())||sig.length!==32)return false;
  return crypto.timingSafeEqual(Buffer.from(sig),Buffer.from(downloadSig(exp)));
}
const IOS_IPA=path.join(DOWNLOADS_DIR,'ActiveTogether.ipa'),IOS_INFO=path.join(DOWNLOADS_DIR,'ios.json');
function iosRelease(){
  try{if(!fs.existsSync(IOS_IPA))return null;const info=JSON.parse(fs.readFileSync(IOS_INFO,'utf8'));return {...info,size:fs.statSync(IOS_IPA).size}}
  catch(e){return null}
}
function androidRelease(){
  try{if(!fs.existsSync(ANDROID_APK))return null;const info=JSON.parse(fs.readFileSync(ANDROID_INFO,'utf8'));return {...info,size:fs.statSync(ANDROID_APK).size}}
  catch(e){return null}
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
 let p=url.pathname==='/'?'index.html':url.pathname.slice(1);p=path.normalize(p).replace(/^\.\.(\/|\\|$)/,'');let f=path.join(__dirname,'public',p);if(!f.startsWith(path.join(__dirname,'public')))return send(res,404,{error:'Not found'});
 // Page addresses (/challenges/12, /join/ABC123, /help...) all load the app, which reads the path itself.
 if(!fs.existsSync(f)||!fs.statSync(f).isFile()){if(req.method==='GET'&&!path.extname(p))f=path.join(__dirname,'public','index.html');else return send(res,404,{error:'Not found'})}
 const ext=path.extname(f),types={'.json':'application/json','.html':'text/html; charset=utf-8','.css':'text/css','.js':'application/javascript','.svg':'image/svg+xml','.ico':'image/x-icon','.png':'image/png'};res.writeHead(200,{'Content-Type':types[ext]||'application/octet-stream','Cache-Control':'no-store'});fs.createReadStream(f).pipe(res)}catch(e){console.error(e);send(res,500,{error:'Server error'})}});// Node's default keepAliveTimeout is 5s, which races a client that reuses a pooled keep-alive
// connection right as the server decides to close it - the client's write lands on a socket the
// server is already tearing down, seen as a bare ECONNRESET with no HTTP response at all.
// headersTimeout must exceed keepAliveTimeout or Node logs a warning and clamps it back down.
server.keepAliveTimeout=65_000;
server.headersTimeout=66_000;
server.listen(PORT,()=>console.log(`Activity Challenge running on ${ORIGIN}`));
