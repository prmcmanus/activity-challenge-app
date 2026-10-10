'use strict';
const http=require('node:http'), fs=require('node:fs'), path=require('node:path'), crypto=require('node:crypto');
const {DatabaseSync}=require('node:sqlite');
const PORT=Number(process.env.PORT||3000), DATA=process.env.DATA_DIR||'.', ORIGIN=process.env.APP_ORIGIN||`http://localhost:${PORT}`;
fs.mkdirSync(DATA,{recursive:true}); const db=new DatabaseSync(path.join(DATA,'activity.sqlite'));
// WAL with synchronous=NORMAL: safe against the app crashing, and much quicker to write (Litestream copies the WAL).
db.exec(`PRAGMA foreign_keys=ON;PRAGMA journal_mode=WAL;PRAGMA synchronous=NORMAL;PRAGMA busy_timeout=5000;
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
// Sessions are 'web' (the cookie) or 'app' (the phone apps' bearer token); each is extended whenever it's
// used, so only people who stop using it get signed out.
ensureColumn('sessions','kind','TEXT');
// Two-step sign-in with an authenticator app: the secret (base32), one being set up, and the last 30-second
// step used, so a code can't be used twice. Backup codes are kept as hashes.
ensureColumn('users','totp_secret','TEXT');
ensureColumn('users','totp_pending','TEXT');
ensureColumn('users','totp_last_step','INTEGER');
// Two-step secrets are encrypted in the database (AES-256-GCM) with TOTP_ENCRYPTION_KEY (32 random bytes, base64) from
// the server's settings, so a copy of the database - a backup - doesn't give them away. The standby needs the same
// key. Without one they're stored as they are.
const TOTP_KEY=(()=>{const k=process.env.TOTP_ENCRYPTION_KEY||'';if(!k)return null;const b=Buffer.from(k,'base64');if(b.length!==32){console.error('TOTP_ENCRYPTION_KEY must be 32 bytes, base64 - two-step secrets are NOT being encrypted');return null}return b})();
function sealSecret(v){
  if(!v||!TOTP_KEY||String(v).startsWith('enc:'))return v;
  const iv=crypto.randomBytes(12),c=crypto.createCipheriv('aes-256-gcm',TOTP_KEY,iv),ct=Buffer.concat([c.update(String(v),'utf8'),c.final()]);
  return `enc:v1:${iv.toString('base64')}:${c.getAuthTag().toString('base64')}:${ct.toString('base64')}`;
}
function openSecret(v){
  if(!v||!String(v).startsWith('enc:v1:'))return v;
  if(!TOTP_KEY){console.error('A two-step secret is encrypted but TOTP_ENCRYPTION_KEY is not set');return null}
  try{const [,,iv,tag,ct]=String(v).split(':'),d=crypto.createDecipheriv('aes-256-gcm',TOTP_KEY,Buffer.from(iv,'base64'));d.setAuthTag(Buffer.from(tag,'base64'));return Buffer.concat([d.update(Buffer.from(ct,'base64')),d.final()]).toString('utf8')}
  catch(e){console.error('A two-step secret could not be decrypted (wrong TOTP_ENCRYPTION_KEY?)');return null}
}
// Secrets saved before encryption was switched on are encrypted at start-up.
if(TOTP_KEY)for(const r of db.prepare("SELECT id,totp_secret,totp_pending FROM users WHERE (totp_secret IS NOT NULL AND totp_secret NOT LIKE 'enc:%') OR (totp_pending IS NOT NULL AND totp_pending NOT LIKE 'enc:%')").all())
  db.prepare('UPDATE users SET totp_secret=?,totp_pending=? WHERE id=?').run(sealSecret(r.totp_secret),sealSecret(r.totp_pending),r.id);
db.exec(`CREATE TABLE IF NOT EXISTS totp_backup_codes(user_id INTEGER NOT NULL,code_hash TEXT NOT NULL,used_at TEXT,
  PRIMARY KEY(user_id,code_hash),FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE)`);
// Signing in with Google or Apple: each account those link to. An account made this way has no password until
// its owner sets one (password_hash '!', which no password matches).
db.exec(`CREATE TABLE IF NOT EXISTS identities(provider TEXT NOT NULL,sub TEXT NOT NULL,user_id INTEGER NOT NULL,email TEXT,created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(provider,sub),FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE);
CREATE INDEX IF NOT EXISTS identities_user ON identities(user_id);`);
const NO_PASSWORD='!',hasPassword=h=>String(h||'').includes(':');
// Confirmed email addresses (see sendEmailCheck): the address someone is changing to waits in pending_email until
// it's confirmed. Accounts from before confirming existed count as confirmed.
{const had=db.prepare('PRAGMA table_info(users)').all().some(c=>c.name==='email_verified_at');ensureColumn('users','email_verified_at','TEXT');if(!had)db.exec("UPDATE users SET email_verified_at=COALESCE(created_at,datetime('now'))")}
ensureColumn('users','pending_email','TEXT');
db.exec(`CREATE TABLE IF NOT EXISTS email_checks(token_hash TEXT PRIMARY KEY,user_id INTEGER NOT NULL,email TEXT NOT NULL,expires_at TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE)`);
// Signed-in devices: when each session started and was last used, and what it is ("Firefox on Windows", "Android app").
ensureColumn('sessions','created_at','TEXT');
ensureColumn('sessions','last_used_at','TEXT');
ensureColumn('sessions','device','TEXT');
db.exec("UPDATE sessions SET created_at=datetime('now') WHERE created_at IS NULL");
// Phone notifications: each app install's push token, tied to the session that registered it, so signing that
// session out (or it expiring) stops them.
ensureColumn('users','notify_push','INTEGER NOT NULL DEFAULT 1');
db.exec(`CREATE TABLE IF NOT EXISTS push_devices(token TEXT PRIMARY KEY,user_id INTEGER NOT NULL,platform TEXT NOT NULL,session_hash TEXT,created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,FOREIGN KEY(session_hash) REFERENCES sessions(token_hash) ON DELETE CASCADE);
CREATE INDEX IF NOT EXISTS push_devices_user ON push_devices(user_id);`);
// Emails: about my tickets and being added to a challenge (everyone), and about new support tickets (admins).
ensureColumn('users','notify_email','INTEGER NOT NULL DEFAULT 1');
// Added by someone else (an owner or a global admin) rather than joining: who, and whether they've said keep.
ensureColumn('challenge_members','added_by','INTEGER');
ensureColumn('challenge_members','added_ack','INTEGER NOT NULL DEFAULT 1');
ensureColumn('users','notify_admin','INTEGER NOT NULL DEFAULT 1');
// Emergency switch: CLEAR_TWO_FACTOR_FOR=email turns off that account's two-step sign-in at start-up (for an
// admin who has lost both their phone and their backup codes). Remove it again afterwards.
if(process.env.CLEAR_TWO_FACTOR_FOR){
  const r=db.prepare('UPDATE users SET totp_secret=NULL,totp_pending=NULL,totp_last_step=NULL WHERE email=?').run(String(process.env.CLEAR_TWO_FACTOR_FOR).toLowerCase().trim());
  console.log(r.changes?`Two-step sign-in turned off for ${process.env.CLEAR_TWO_FACTOR_FOR} (CLEAR_TWO_FACTOR_FOR) - remove that setting now`:`CLEAR_TWO_FACTOR_FOR: no account uses ${process.env.CLEAR_TWO_FACTOR_FOR}`);
}
// Apple Shortcuts sync: a personal key, stored only as a hash, lets a shortcut on an iPhone send a day's
// totals from Apple Health without signing in. Making a new key replaces the old one.
ensureColumn('users','sync_key_hash','TEXT');
ensureColumn('users','sync_key_created_at','TEXT');
// Keys are per device: making a new one (for another iPhone, or to paste in) leaves the others working.
// The newest few per person are kept. Keys from before this move across once.
db.exec(`CREATE TABLE IF NOT EXISTS sync_keys(id INTEGER PRIMARY KEY,user_id INTEGER NOT NULL,key_hash TEXT UNIQUE NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE)`);
db.exec(`INSERT OR IGNORE INTO sync_keys(user_id,key_hash,created_at) SELECT id,sync_key_hash,COALESCE(sync_key_created_at,datetime('now')) FROM users WHERE sync_key_hash IS NOT NULL;
  UPDATE users SET sync_key_hash=NULL,sync_key_created_at=NULL WHERE sync_key_hash IS NOT NULL;`);
const SYNC_KEYS_KEPT=5;
const sha256hex=v=>crypto.createHash('sha256').update(String(v)).digest('hex');
// Password resets: a one-time link, stored only as a hash. Sent by email when an email service is set up
// (RESEND_API_KEY), or made by a global admin to pass on themselves.
db.exec(`CREATE TABLE IF NOT EXISTS password_resets(token_hash TEXT PRIMARY KEY,user_id INTEGER NOT NULL,expires_at TEXT NOT NULL,used_at TEXT,created_by INTEGER,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE)`);
// A lasting record of what global admins and challenge owners do to other people's accounts and entries
// (deletions, removals, password resets, role changes...), for global admins to look back on. Kept a year.
db.exec(`CREATE TABLE IF NOT EXISTS audit_log(id INTEGER PRIMARY KEY,at TEXT DEFAULT CURRENT_TIMESTAMP,actor_id INTEGER,action TEXT NOT NULL,
  target_user_id INTEGER,challenge_id INTEGER,detail TEXT);
CREATE INDEX IF NOT EXISTS audit_log_at ON audit_log(at);`);
function audit(actor,action,{user=null,challenge=null,detail=null}={}){
  try{db.prepare('INSERT INTO audit_log(actor_id,action,target_user_id,challenge_id,detail) VALUES(?,?,?,?,?)').run(actor?actor.id??actor:null,action,user,challenge,detail==null?null:String(detail).slice(0,500))}
  catch(e){console.error('Audit log write failed',e)}
}
// Site-wide settings a global admin can change. invite_only: '1' when creating an account needs an invite.
db.exec('CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT)');
const getSetting=k=>db.prepare('SELECT value FROM settings WHERE key=?').get(k)?.value??null;
const setSetting=(k,v)=>db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(k,String(v));
const inviteOnly=()=>getSetting('invite_only')==='1';
// What counts as an invite: a challenge or team invite code, or an emailed team invite that is still open.
function validInvite(code,token){
  const c=String(code||'').trim().toUpperCase();
  if(c&&(db.prepare('SELECT 1 FROM challenges WHERE invite_code=?').get(c)||db.prepare('SELECT 1 FROM teams WHERE invite_code=?').get(c)))return true;
  return !!(token&&db.prepare("SELECT 1 FROM invites WHERE token=? AND accepted_at IS NULL AND expires_at>datetime('now')").get(String(token)));
}
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
// Lookups the leaderboards, dashboards and membership checks make on every page.
db.exec(`CREATE INDEX IF NOT EXISTS challenge_members_user ON challenge_members(user_id);
CREATE INDEX IF NOT EXISTS teams_challenge ON teams(challenge_id);
CREATE INDEX IF NOT EXISTS team_members_user ON team_members(user_id);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);`);
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
// After the rebuild above, which would drop indexes on the old table.
db.exec(`CREATE INDEX IF NOT EXISTS activities_challenge ON activities(challenge_id);
CREATE INDEX IF NOT EXISTS activities_team ON activities(team_id);
CREATE INDEX IF NOT EXISTS activities_user_date ON activities(user_id,activity_date);
CREATE INDEX IF NOT EXISTS activities_route ON activities(route_id);`);
// Each challenge's standings version: moved on by the database itself whenever anything its leaderboards and
// journey map show changes (entries, teams, members, the challenge, a member's name or photo), so cached
// standings are reused until then, challenge by challenge, however the change was made.
{
  const bump=expr=>`INSERT OR IGNORE INTO standings_version(challenge_id) VALUES(${expr});UPDATE standings_version SET v=v+1 WHERE challenge_id=${expr};`;
  const bumpUser=expr=>`INSERT OR IGNORE INTO standings_version(challenge_id) SELECT challenge_id FROM challenge_members WHERE user_id=${expr};UPDATE standings_version SET v=v+1 WHERE challenge_id IN (SELECT challenge_id FROM challenge_members WHERE user_id=${expr});`;
  const triggers=[
    ['sv_act_ins','AFTER INSERT ON activities',bump('NEW.challenge_id')],['sv_act_upd','AFTER UPDATE ON activities',bump('OLD.challenge_id')+bump('NEW.challenge_id')],['sv_act_del','AFTER DELETE ON activities',bump('OLD.challenge_id')],
    ['sv_team_ins','AFTER INSERT ON teams',bump('NEW.challenge_id')],['sv_team_upd','AFTER UPDATE ON teams',bump('NEW.challenge_id')],['sv_team_del','AFTER DELETE ON teams',bump('OLD.challenge_id')],
    ['sv_mem_ins','AFTER INSERT ON challenge_members',bump('NEW.challenge_id')],['sv_mem_upd','AFTER UPDATE ON challenge_members',bump('NEW.challenge_id')],['sv_mem_del','AFTER DELETE ON challenge_members',bump('OLD.challenge_id')],
    ['sv_ch_upd','AFTER UPDATE ON challenges',bump('NEW.id')],['sv_ch_del','BEFORE DELETE ON challenges',bump('OLD.id')],
    ['sv_user_upd','AFTER UPDATE OF name,avatar_url ON users',bumpUser('NEW.id')],['sv_user_del','BEFORE DELETE ON users',bumpUser('OLD.id')],
  ];
  db.exec('CREATE TABLE IF NOT EXISTS standings_version(challenge_id INTEGER PRIMARY KEY,v INTEGER NOT NULL DEFAULT 0)');
  for(const [name,when,body] of triggers)db.exec(`CREATE TRIGGER IF NOT EXISTS ${name} ${when} BEGIN ${body} END`);
}

// --- uploaded images (avatars, team logos, description images) --------------------------
// Stored under DATA_DIR (the persistent volume), never under the app's own public/ dir, which
// is baked into the Docker image and wiped on every rebuild.
const UPLOADS_DIR=path.join(DATA,'uploads');
fs.mkdirSync(UPLOADS_DIR,{recursive:true});
// Pictures are shrunk on the phone or in the browser before they're sent, so 3MB is plenty.
const UPLOAD_MAX_BYTES=3*1024*1024;
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
      // Pictures only from this site's uploads: an outside image would tell its host who opened the challenge.
      if(attrName==='src'&&!UPLOAD_URL_RE.test(attrVal.trim()))continue;
      attrs+=` ${attrName}="${attrVal.replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}"`;
    }
    if(tagName==='img'&&!/ src="/.test(attrs))continue;
    out+=`<${tagName}${attrs}>`;
  }
  return out;
}

// Passwords: scrypt, run off the main thread so a sign-in never stalls everyone else's requests.
const scryptAsync=(p,salt)=>new Promise((resolve,reject)=>crypto.scrypt(String(p),salt,64,(e,k)=>e?reject(e):resolve(k)));
const hashSync=p=>{const salt=crypto.randomBytes(16).toString('hex');return salt+':'+crypto.scryptSync(p,salt,64).toString('hex')};
// --- two-step sign-in (RFC 6238 TOTP: SHA-1, 30 seconds, 6 digits, as every authenticator app does) ---
const B32='ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function b32encode(buf){let bits=0,val=0,out='';for(const b of buf){val=(val<<8)|b;bits+=8;while(bits>=5){out+=B32[(val>>>(bits-5))&31];bits-=5;val&=(1<<bits)-1}}if(bits>0)out+=B32[(val<<(5-bits))&31];return out}
function b32decode(str){let bits=0,val=0;const out=[];for(const ch of String(str).toUpperCase().replace(/[^A-Z2-7]/g,'')){val=(val<<5)|B32.indexOf(ch);bits+=5;if(bits>=8){out.push((val>>>(bits-8))&255);bits-=8;val&=(1<<bits)-1}}return Buffer.from(out)}
function totpAt(secret,step){
  const msg=Buffer.alloc(8);msg.writeBigUInt64BE(BigInt(step));
  const h=crypto.createHmac('sha1',b32decode(secret)).update(msg).digest(),o=h[h.length-1]&15;
  return String((((h[o]&127)<<24)|(h[o+1]<<16)|(h[o+2]<<8)|h[o+3])%1e6).padStart(6,'0');
}
// The step a code matches (this 30 seconds, or one either side for a clock that's a little out), never one
// already used; null if none.
function totpStep(secret,code,lastStep){
  const c=String(code||'').replace(/\s/g,'');if(!/^\d{6}$/.test(c))return null;
  const now=Math.floor(Date.now()/30000);
  for(const step of [now-1,now,now+1])if(step>(lastStep||0)&&crypto.timingSafeEqual(Buffer.from(totpAt(secret,step)),Buffer.from(c)))return step;
  return null;
}
const normaliseBackup=c=>String(c||'').toUpperCase().replace(/[^A-Z0-9]/g,'');
function newBackupCodes(uid){
  db.prepare('DELETE FROM totp_backup_codes WHERE user_id=?').run(uid);
  const codes=Array.from({length:10},()=>{const c=genCode(8);return `${c.slice(0,4)}-${c.slice(4)}`});
  const ins=db.prepare('INSERT INTO totp_backup_codes(user_id,code_hash) VALUES(?,?)');
  for(const c of codes)ins.run(uid,sha256hex(normaliseBackup(c)));
  return codes;
}
// A code from the authenticator app, or one of the backup codes (each works once). True if it's good.
function checkSecondFactor(user,code){
  const secret=openSecret(user.totp_secret),step=secret?totpStep(secret,code,user.totp_last_step):null;
  if(step!==null){db.prepare('UPDATE users SET totp_last_step=? WHERE id=?').run(step,user.id);return true}
  const b=normaliseBackup(code);
  if(b.length!==8)return false;
  return db.prepare("UPDATE totp_backup_codes SET used_at=datetime('now') WHERE user_id=? AND code_hash=? AND used_at IS NULL").run(user.id,sha256hex(b)).changes===1;
}
// Between the password and the code: a ticket naming the account and where the session will be (web or app),
// signed with a key that lives only as long as this process, and good for 5 minutes.
const LOGIN_TICKET_KEY=crypto.randomBytes(32);
const ticketSig=v=>crypto.createHmac('sha256',LOGIN_TICKET_KEY).update(v).digest('base64url');
const makeLoginTicket=(uid,kind)=>{const v=`${uid}.${kind}.${Date.now()+5*60e3}`;return `${v}.${ticketSig(v)}`};
function readLoginTicket(t,kind){
  const p=String(t||'').split('.');if(p.length!==4)return null;
  const want=Buffer.from(ticketSig(p.slice(0,3).join('.'))),got=Buffer.from(p[3]);
  if(want.length!==got.length||!crypto.timingSafeEqual(want,got)||p[1]!==kind||!(Number(p[2])>Date.now()))return null;
  return Number(p[0]);
}
const hash=async p=>{const salt=crypto.randomBytes(16).toString('hex');return salt+':'+(await scryptAsync(p,salt)).toString('hex')};
const verify=async(p,h)=>{const [s,k]=String(h).split(':');const key=Buffer.from(k||'','hex');const got=await scryptAsync(p,s||'');return key.length===got.length&&crypto.timingSafeEqual(key,got)};
// Checked against when an email has no account, so a wrong email takes as long as a wrong password.
const DUMMY_HASH=hashSync(crypto.randomBytes(16).toString('hex'));
// Passwords: at least 8 characters, not one of the 20,000 most common (the UK NCSC's list of passwords seen in
// breaches - the ones tried first), and not the account's own email or name.
const COMMON_PASSWORDS=new Set((()=>{try{return fs.readFileSync(path.join(__dirname,'common-passwords.txt'),'utf8').split('\n').map(x=>x.trim()).filter(Boolean)}catch(e){console.error('common-passwords.txt is missing: common passwords are not being refused');return []}})());
function passwordProblem(p,{email='',name=''}={}){
  const pw=String(p||''),low=pw.toLowerCase(),mail=String(email).toLowerCase(),local=mail.split('@')[0];
  if(pw.length<8)return 'Choose a password of at least 8 characters';
  if(pw.length>200)return 'That password is too long - 200 characters at most';
  if(COMMON_PASSWORDS.has(low))return "That's one of the most common passwords, so it's easy to guess. Choose another.";
  if(low===mail||(local.length>=4&&low.includes(local))||(name&&low.replace(/[^a-z0-9]/g,'')===String(name).toLowerCase().replace(/[^a-z0-9]/g,'')))return "Don't use your email address or name as your password. Choose another.";
  if(/^(.)\1+$/.test(pw))return "Choose a password that isn't one character over and over.";
  return null;
}
// What people can type: generous, but bounded, so a name can't fill a page (or the database).
const MAX_LEN={person:80,challenge:100,team:60,activity:60,description:20000};
const tooLong=(v,max,what)=>String(v||'').length>max?`Keep ${what} to ${max} characters or fewer`:null;
const validEmail=e=>e.length<=254&&/^[^\s@]{1,64}@[^\s@]+\.[^\s@]{2,}$/.test(e);

// --- bot/abuse precautions ---------------------------------------------------------------
// In-memory, per-IP, fixed-window counters. Resets on restart, which is an acceptable escape
// hatch for a self-hosted app this size (matches how ITCM's login lockout works).
const API_RATE_LIMIT_MAX=Number(process.env.API_RATE_LIMIT_MAX||300), API_RATE_LIMIT_WINDOW_MS=Number(process.env.API_RATE_LIMIT_WINDOW_MS||60_000);
// Signed in, the limit is per person; a whole network (an office behind one address) gets ten times that.
const API_NETWORK_RATE_LIMIT_MAX=Number(process.env.API_NETWORK_RATE_LIMIT_MAX||API_RATE_LIMIT_MAX*10);
const AUTH_RATE_LIMIT_MAX=Number(process.env.AUTH_RATE_LIMIT_MAX||20), AUTH_RATE_LIMIT_WINDOW_MS=Number(process.env.AUTH_RATE_LIMIT_WINDOW_MS||15*60_000);
// Sign-in attempts count per network and email, so a whole office behind one address can sign in on a Monday
// morning; a network as a whole gets five times that, which still stops one address trying many accounts.
// Sign-ups get three times the per-network limit, for a team all registering at once.
const LOGIN_NETWORK_MAX=Number(process.env.LOGIN_NETWORK_RATE_LIMIT_MAX||AUTH_RATE_LIMIT_MAX*5);
const REGISTER_RATE_LIMIT_MAX=Number(process.env.REGISTER_RATE_LIMIT_MAX||AUTH_RATE_LIMIT_MAX*3);
const loginLimited=(kind,ip,email)=>hitRateLimit(`${kind}:${ip}:${String(email||'').toLowerCase().trim()}`,AUTH_RATE_LIMIT_MAX,AUTH_RATE_LIMIT_WINDOW_MS)|hitRateLimit(`${kind}net:${ip}`,LOGIN_NETWORK_MAX,AUTH_RATE_LIMIT_WINDOW_MS);
const UPLOAD_RATE_LIMIT_MAX=Number(process.env.UPLOAD_RATE_LIMIT_MAX||30), UPLOAD_RATE_LIMIT_WINDOW_MS=Number(process.env.UPLOAD_RATE_LIMIT_WINDOW_MS||15*60_000);
const rateBuckets=new Map();
function hitRateLimit(key,max,windowMs){const now=Date.now(),b=rateBuckets.get(key);if(!b||b.resetAt<=now){rateBuckets.set(key,{count:1,resetAt:now+windowMs});return false}b.count++;return b.count>max}
// How many times a key has been counted in its current window, without counting this look.
const peekRate=key=>{const b=rateBuckets.get(key);return b&&b.resetAt>Date.now()?b.count:0};
// Invite codes that don't work: a few an hour per account, and a few more per network (an office mistyping), so
// nobody can find a challenge by trying codes. Right codes never count.
const CODE_FAIL_MAX=Number(process.env.CODE_FAIL_MAX||10),CODE_FAIL_NET_MAX=Number(process.env.CODE_FAIL_NET_MAX||30),CODE_FAIL_WINDOW_MS=60*60_000;
const codeGuessBlocked=(ip,uid)=>peekRate('codefail:'+ip)>=CODE_FAIL_NET_MAX||(!!uid&&peekRate('codefailu:'+uid)>=CODE_FAIL_MAX);
const noteBadCode=(ip,uid)=>{hitRateLimit('codefail:'+ip,CODE_FAIL_NET_MAX,CODE_FAIL_WINDOW_MS);if(uid)hitRateLimit('codefailu:'+uid,CODE_FAIL_MAX,CODE_FAIL_WINDOW_MS)};
const CODE_BLOCKED={error:"Too many invite codes that didn't work. Wait an hour and try again, or ask for the invite link.",codeBlocked:true};
setInterval(()=>{const now=Date.now();for(const [k,b] of rateBuckets)if(b.resetAt<=now)rateBuckets.delete(k)},10*60_000).unref();
// Prefer Cloudflare's own header (this deployment sits behind a Cloudflare Tunnel) over the
// generic, more easily spoofed X-Forwarded-For.
const clientIp=req=>req.headers['cf-connecting-ip']||(req.headers['x-forwarded-for']||'').split(',')[0].trim()||req.socket.remoteAddress||'unknown';

// reCAPTCHA is opt-in: unset RECAPTCHA_SECRET_KEY (the default) disables verification entirely,
// so local dev and automated tests work with no Google keys registered. The site key is public
// and served from /api/config so the frontend never needs it baked in at build time.
const RECAPTCHA_SITE_KEY=process.env.RECAPTCHA_SITE_KEY||'', RECAPTCHA_SECRET_KEY=process.env.RECAPTCHA_SECRET_KEY||'';
// Email (password reset links) through Resend's HTTP API, when a key is set. MAIL_FROM must be an address on a
// domain verified with Resend.
const RESEND_API_KEY=process.env.RESEND_API_KEY||'',MAIL_FROM=process.env.MAIL_FROM||'Active Together <no-reply@activetogether.team>';
const RESEND_API_URL=process.env.RESEND_API_URL||'https://api.resend.com/emails';
const emailEnabled=()=>!!RESEND_API_KEY;
// --- Sign in with Google / Apple ------------------------------------------------------------------------
// The browser or app signs in with the provider and hands us its ID token (a JWT); we check its signature
// against the provider's published keys, that it was issued for one of our apps, and that it's current.
// Google: GOOGLE_WEB_CLIENT_ID (the website, and the Android app, which asks for tokens for it) and
// GOOGLE_IOS_CLIENT_ID. Apple: the iPhone app's bundle ID, and APPLE_SERVICES_ID for the website.
const GOOGLE_WEB_CLIENT_ID=process.env.GOOGLE_WEB_CLIENT_ID||'',GOOGLE_IOS_CLIENT_ID=process.env.GOOGLE_IOS_CLIENT_ID||'';
const APPLE_SERVICES_ID=process.env.APPLE_SERVICES_ID||'',APPLE_BUNDLE_ID=process.env.APPLE_BUNDLE_ID||'team.activetogether.companion';
const SOCIAL={
  google:{label:'Google',jwks:process.env.GOOGLE_JWKS_URL||'https://www.googleapis.com/oauth2/v3/certs',issuers:['accounts.google.com','https://accounts.google.com'],
    audiences:()=>[GOOGLE_WEB_CLIENT_ID,GOOGLE_IOS_CLIENT_ID].filter(Boolean)},
  apple:{label:'Apple',jwks:process.env.APPLE_JWKS_URL||'https://appleid.apple.com/auth/keys',issuers:['https://appleid.apple.com'],
    audiences:()=>[APPLE_BUNDLE_ID,APPLE_SERVICES_ID].filter(Boolean)},
};
const jwksCache=new Map();
async function providerKeys(url,fresh=false){
  const hit=jwksCache.get(url);if(hit&&!fresh&&hit.until>Date.now())return hit.keys;
  const r=await fetch(url,{signal:AbortSignal.timeout(10000)});if(!r.ok)throw Error('keys unavailable');
  const keys=(await r.json()).keys||[],age=Number(((r.headers.get('cache-control')||'').match(/max-age=(\d+)/)||[])[1]||3600);
  jwksCache.set(url,{keys,until:Date.now()+Math.min(age,86400)*1000});return keys;
}
async function verifyIdToken(provider,token){
  const cfg=SOCIAL[provider],parts=String(token||'').split('.');
  if(parts.length!==3)throw Error('not a token');
  const header=JSON.parse(Buffer.from(parts[0],'base64url')),claims=JSON.parse(Buffer.from(parts[1],'base64url'));
  if(header.alg!=='RS256')throw Error('unexpected algorithm');
  let key=(await providerKeys(cfg.jwks)).find(k=>k.kid===header.kid);
  if(!key)key=(await providerKeys(cfg.jwks,true)).find(k=>k.kid===header.kid); // the provider rotated its keys
  if(!key)throw Error('unknown key');
  if(!crypto.verify('RSA-SHA256',Buffer.from(`${parts[0]}.${parts[1]}`),crypto.createPublicKey({key,format:'jwk'}),Buffer.from(parts[2],'base64url')))throw Error('bad signature');
  const auds=[].concat(claims.aud),now=Date.now()/1000;
  if(!cfg.issuers.includes(claims.iss)||!auds.some(a=>cfg.audiences().includes(a))||!(claims.exp>now-60)||!claims.sub)throw Error('not for us');
  return claims;
}
// Confirming an email address: a link, good for three days, sent to it. Until it's used the account works, but
// nothing else is emailed there, and signing in with Google or Apple as that address takes the account over (in
// case whoever made it didn't own the address). Changing the address waits for the new one to be confirmed.
function sendEmailCheck(uid,email,{change=false}={}){
  if(!emailEnabled())return false;
  const t=crypto.randomBytes(32).toString('base64url');
  db.prepare('DELETE FROM email_checks WHERE user_id=?').run(uid);
  db.prepare("INSERT INTO email_checks(token_hash,user_id,email,expires_at) VALUES(?,?,?,datetime('now','+3 days'))").run(sha256hex(t),uid,email);
  sendMail({to:email,subject:change?'Confirm your new email address for Active Together':'Confirm your email address for Active Together',
    text:`Hello,\n\n${change?'To use this address for your Active Together account, open this link':'Please confirm this is your email address for Active Together: open this link'} within the next three days:\n\n${ORIGIN}/verify/${t}\n\nIf you didn't ${change?'ask for this':'make an account'}, ignore this email${change?' - nothing changes':''}.\n\nActive Together\n${ORIGIN}`});
  return true;
}
// A note to the account's (confirmed) address when something about signing in to it changes, so a change made by
// someone else doesn't go unseen. Sent whatever the email settings say.
function securityMail(uid,what,{to=null}={}){
  const x=db.prepare('SELECT email,email_verified_at FROM users WHERE id=?').get(uid);
  if(!x||!(to||x.email_verified_at))return;
  sendMail({to:to||x.email,subject:'Security notice from Active Together',text:`Hello,\n\n${what} - on the Active Together account for ${x.email}, at ${new Date().toISOString().slice(0,16).replace('T',' ')} UTC.\n\nIf that was you, there's nothing to do.\n\nIf it wasn't, reset your password now at ${ORIGIN}/forgot and tell us at support@activetogether.team.\n\nActive Together\n${ORIGIN}`});
}
// Replies go to the support mailbox rather than the no-reply sender.
const MAIL_REPLY_TO=process.env.MAIL_REPLY_TO||'support@activetogether.team';
async function sendMail({to,subject,text}){
  if(!RESEND_API_KEY)return false;
  try{
    const r=await fetch(RESEND_API_URL,{method:'POST',headers:{Authorization:`Bearer ${RESEND_API_KEY}`,'Content-Type':'application/json'},
      body:JSON.stringify({from:MAIL_FROM,to:[to],reply_to:MAIL_REPLY_TO,subject,text}),signal:AbortSignal.timeout(15000)});
    if(!r.ok){console.error('Email not sent:',r.status,(await r.text()).slice(0,200));return false}
    return true;
  }catch(e){console.error('Email not sent:',e.message);return false}
}
// --- Phone notifications ------------------------------------------------------------------------------------------
// Android through Firebase Cloud Messaging: FCM_SERVICE_ACCOUNT (the Firebase service account's JSON key, as it is or
// base64), plus the Android app's Firebase details, which the app fetches from /api/config so it needs no rebuild:
// FCM_ANDROID_APP_ID, FCM_API_KEY and FCM_SENDER_ID. iPhone through Apple's push service: APNS_KEY (the .p8 key, as
// it is or base64), APNS_KEY_ID, APNS_TEAM_ID (and APNS_TOPIC, the app's bundle ID). Each is off until it's set up.
const envJson=v=>{if(!v)return null;for(const t of [v,Buffer.from(v,'base64').toString('utf8')])try{return JSON.parse(t)}catch(e){}console.error('FCM_SERVICE_ACCOUNT is not valid JSON');return null};
const FCM_SA=envJson(process.env.FCM_SERVICE_ACCOUNT||'');
const FCM={appId:process.env.FCM_ANDROID_APP_ID||'',apiKey:process.env.FCM_API_KEY||'',senderId:process.env.FCM_SENDER_ID||'',
  tokenUrl:process.env.FCM_TOKEN_URL||'https://oauth2.googleapis.com/token',sendBase:(process.env.FCM_SEND_BASE||'https://fcm.googleapis.com').replace(/\/$/,'')};
const APNS_KEY=(()=>{const v=process.env.APNS_KEY||'';if(!v)return null;try{return crypto.createPrivateKey(v.includes('BEGIN')?v:Buffer.from(v,'base64').toString('utf8'))}catch(e){console.error('APNS_KEY is not a valid .p8 key');return null}})();
const APNS={keyId:process.env.APNS_KEY_ID||'',teamId:process.env.APNS_TEAM_ID||'',topic:process.env.APNS_TOPIC||'team.activetogether.companion',host:process.env.APNS_HOST||'https://api.push.apple.com'};
const pushEnabled={android:!!(FCM_SA&&FCM_SA.private_key&&FCM_SA.client_email&&FCM_SA.project_id&&FCM.appId&&FCM.apiKey&&FCM.senderId),ios:!!(APNS_KEY&&APNS.keyId&&APNS.teamId)};
const b64url=o=>Buffer.from(typeof o==='string'?o:JSON.stringify(o)).toString('base64url');
let fcmAccess=null;
async function fcmAccessToken(){
  if(fcmAccess&&fcmAccess.until>Date.now()+60e3)return fcmAccess.value;
  const now=Math.floor(Date.now()/1000),head=b64url({alg:'RS256',typ:'JWT'}),claims=b64url({iss:FCM_SA.client_email,scope:'https://www.googleapis.com/auth/firebase.messaging',aud:FCM.tokenUrl,iat:now,exp:now+3600});
  const sig=crypto.sign('RSA-SHA256',Buffer.from(`${head}.${claims}`),FCM_SA.private_key).toString('base64url');
  const r=await fetch(FCM.tokenUrl,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'urn:ietf:params:oauth:grant-type:jwt-bearer',assertion:`${head}.${claims}.${sig}`}),signal:AbortSignal.timeout(15000)});
  const j=await r.json().catch(()=>({}));if(!r.ok||!j.access_token)throw new Error(`Firebase sign-in failed (${r.status})`);
  fcmAccess={value:j.access_token,until:Date.now()+(j.expires_in||3600)*1000};return fcmAccess.value;
}
async function sendFcm(token,msg){
  const r=await fetch(`${FCM.sendBase}/v1/projects/${FCM_SA.project_id}/messages:send`,{method:'POST',headers:{Authorization:`Bearer ${await fcmAccessToken()}`,'Content-Type':'application/json'},
    body:JSON.stringify({message:{token,notification:{title:msg.title,body:msg.body},data:{url:msg.url||'/'},android:{priority:'high',notification:{channel_id:'updates'}}}}),signal:AbortSignal.timeout(15000)});
  if(r.ok)return 'ok';
  const t=await r.text();
  if(r.status===404||/UNREGISTERED|registration token/i.test(t))return 'gone';
  throw new Error(`FCM ${r.status}: ${t.slice(0,200)}`);
}
let apnsJwt=null,apnsSession=null;
function apnsBearer(){
  if(apnsJwt&&apnsJwt.at>Date.now()-40*60e3)return apnsJwt.value;
  const head=b64url({alg:'ES256',kid:APNS.keyId}),claims=b64url({iss:APNS.teamId,iat:Math.floor(Date.now()/1000)});
  apnsJwt={value:`${head}.${claims}.${crypto.sign('sha256',Buffer.from(`${head}.${claims}`),{key:APNS_KEY,dsaEncoding:'ieee-p1363'}).toString('base64url')}`,at:Date.now()};
  return apnsJwt.value;
}
function apnsConnection(){
  if(apnsSession&&!apnsSession.closed&&!apnsSession.destroyed)return apnsSession;
  const sess=require('node:http2').connect(APNS.host);
  sess.on('error',e=>{console.error('APNs connection:',e.message);if(apnsSession===sess)apnsSession=null});
  sess.on('goaway',()=>{if(apnsSession===sess)apnsSession=null});
  sess.setTimeout(10*60_000,()=>sess.close());sess.unref();
  return apnsSession=sess;
}
function sendApns(token,msg){
  return new Promise((resolve,reject)=>{
    let req;
    try{req=apnsConnection().request({':method':'POST',':path':`/3/device/${token}`,authorization:`bearer ${apnsBearer()}`,'apns-topic':APNS.topic,'apns-push-type':'alert','apns-priority':'10','content-type':'application/json'})}catch(e){return reject(e)}
    let status=0,data='';
    req.setTimeout(15000,()=>{req.close();reject(new Error('APNs timed out'))});
    req.on('response',h=>{status=h[':status']});
    req.setEncoding('utf8');req.on('data',c=>data+=c);
    req.on('end',()=>status===200?resolve('ok'):status===410||/BadDeviceToken|Unregistered|DeviceTokenNotForTopic/.test(data)?resolve('gone'):reject(new Error(`APNs ${status}: ${data.slice(0,200)}`)));
    req.on('error',reject);
    req.end(JSON.stringify({aps:{alert:{title:msg.title,body:msg.body},sound:'default'},url:msg.url||'/'}));
  });
}
// Whether someone gets phone notifications (allowed, and a phone the server can reach): news then goes there
// instead of by email. Security notices, confirming links and password resets are always emailed.
function pushReachable(uid){
  if(!pushEnabled.android&&!pushEnabled.ios)return false;
  const ok=[pushEnabled.android&&'android',pushEnabled.ios&&'ios'].filter(Boolean);
  return !!db.prepare(`SELECT 1 FROM push_devices d JOIN users us ON us.id=d.user_id WHERE d.user_id=? AND us.notify_push=1 AND d.platform IN (${ok.map(()=>'?').join(',')}) LIMIT 1`).get(uid,...ok);
}
// To everyone in userIds who allows phone notifications, on each of their phones. Tokens a service says are gone are
// forgotten. Never throws; returns how many were sent.
async function pushTo(userIds,msg){
  if(!pushEnabled.android&&!pushEnabled.ios)return 0;
  const ids=[...new Set(userIds)].filter(Boolean);if(!ids.length)return 0;
  const devices=db.prepare(`SELECT d.token,d.platform FROM push_devices d JOIN users us ON us.id=d.user_id WHERE d.user_id IN (${ids.map(()=>'?').join(',')}) AND us.notify_push=1 AND us.deactivated_at IS NULL`).all(...ids);
  let sent=0;
  for(const d of devices){
    if(!pushEnabled[d.platform])continue;
    try{const r=d.platform==='android'?await sendFcm(d.token,msg):await sendApns(d.token,msg);if(r==='gone')db.prepare('DELETE FROM push_devices WHERE token=?').run(d.token);else sent++}
    catch(e){console.error('Push not sent:',e.message)}
  }
  return sent;
}
// The shared Apple Shortcut (an iCloud link made on an iPhone); the website offers it once set.
// Where to get the apps: the Play listing (PLAY_STORE_LIVE=1 once anyone can install from it, rather than testers), the
// App Store listing once it's live (APP_STORE_URL), and TestFlight until then.
const STORES={play:process.env.PLAY_STORE_URL||'https://play.google.com/store/apps/details?id=com.activetogether.companion',playLive:process.env.PLAY_STORE_LIVE==='1',
  appStore:process.env.APP_STORE_URL||null,testFlight:process.env.TESTFLIGHT_URL||'https://testflight.apple.com/join/cFAwqWKT'};
const SHORTCUT_URL=/^https:\/\/www\.icloud\.com\/shortcuts\/[A-Za-z0-9]+$/.test(process.env.SHORTCUT_URL||'')?process.env.SHORTCUT_URL:'';
// Cloudflare Turnstile (usually invisible, no Google) takes over from reCAPTCHA once its keys are set.
const TURNSTILE_SITE_KEY=process.env.TURNSTILE_SITE_KEY||'',TURNSTILE_SECRET_KEY=process.env.TURNSTILE_SECRET_KEY||'';
const captchaConfig=()=>TURNSTILE_SITE_KEY&&TURNSTILE_SECRET_KEY?{provider:'turnstile',siteKey:TURNSTILE_SITE_KEY}:RECAPTCHA_SITE_KEY&&RECAPTCHA_SECRET_KEY?{provider:'recaptcha',siteKey:RECAPTCHA_SITE_KEY}:null;
async function verifyCaptcha(token,ip){
  if(TURNSTILE_SITE_KEY&&TURNSTILE_SECRET_KEY){
    if(!token)return false;
    try{
      const r=await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({secret:TURNSTILE_SECRET_KEY,response:token,remoteip:ip}),signal:AbortSignal.timeout(10000)});
      return (await r.json()).success===true;
    }catch(e){console.error('Turnstile verification request failed',e);return false}
  }
  return verifyRecaptcha(token,ip);
}
async function verifyRecaptcha(token,ip){
  if(!RECAPTCHA_SECRET_KEY)return true;
  if(!token)return false;
  try{
    const r=await fetch('https://www.google.com/recaptcha/api/siteverify',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({secret:RECAPTCHA_SECRET_KEY,response:token,remoteip:ip})});
    const j=await r.json();
    return j.success===true;
  }catch(e){console.error('reCAPTCHA verification request failed',e);return false}
}
async function attemptLogin(email,password,kind='web',req=null){const x=db.prepare('SELECT * FROM users WHERE email=?').get(String(email||'').toLowerCase().trim());const ok=await verify(password||'',x?x.password_hash:DUMMY_HASH);if(!x||!ok)return null;if(x.deactivated_at)return {deactivated:true};
  // Two-step sign-in: the password was right, so the next step is the code; no session yet.
  if(x.totp_secret)return {twoFactor:true,ticket:makeLoginTicket(x.id,kind)};
  const t=startSession(x.id,kind,req);return {sessionToken:t,user:{id:x.id,email:x.email,name:x.name,role:x.role,avatarUrl:x.avatar_url}}}

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
// Descriptions saved before pictures were limited to uploads lose any outside ones (they are already clean
// HTML from the sanitizer, so each <img> is matched whole).
for(const c of db.prepare("SELECT id,description FROM challenges WHERE description LIKE '%<img%'").all()){
  const cleaned=c.description.replace(/<img\b[^>]*>/g,tag=>/ src="\/uploads\/[a-f0-9]{32}\.(png|jpg|gif|webp)"/.test(tag)?tag:'');
  if(cleaned!==c.description){db.prepare('UPDATE challenges SET description=? WHERE id=?').run(cleaned,c.id);console.log(`Removed outside pictures from challenge ${c.id}'s description`)}
}
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
  db.prepare("INSERT INTO users(email,name,password_hash,role,email_verified_at) VALUES(?,?,?,'global_admin',datetime('now'))").run(seedEmail,'Administrator',hashSync(seedPass));
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
// Uploaded images nothing refers to any more (an old photo, a deleted account's avatar, a purged challenge's
// pictures) are deleted once a day, a day after they were uploaded so one just added isn't caught mid-save.
function sweepUploads(){
  try{
    const used=new Set(),name=v=>{const m=String(v||'').match(/^\/uploads\/([a-f0-9]{32}\.(?:png|jpg|gif|webp))$/);if(m)used.add(m[1])};
    for(const r of db.prepare('SELECT avatar_url v FROM users WHERE avatar_url IS NOT NULL UNION ALL SELECT image_url FROM teams WHERE image_url IS NOT NULL UNION ALL SELECT image_url FROM tickets WHERE image_url IS NOT NULL').all())name(r.v);
    for(const r of db.prepare("SELECT description d FROM challenges WHERE description LIKE '%/uploads/%'").all())for(const m of String(r.d).matchAll(/\/uploads\/([a-f0-9]{32}\.(?:png|jpg|gif|webp))/g))used.add(m[1]);
    const cutoff=Date.now()-864e5;let removed=0;
    for(const f of fs.readdirSync(UPLOADS_DIR)){
      if(used.has(f))continue;
      const p=path.join(UPLOADS_DIR,f),st=fs.statSync(p);
      if(st.isFile()&&st.mtimeMs<cutoff){fs.unlinkSync(p);removed++}
    }
    if(removed)console.log(`Deleted ${removed} uploaded image(s) nothing refers to any more`);
  }catch(e){console.error('Upload clean-up failed',e)}
}
setTimeout(sweepUploads,5*60_000).unref();
setInterval(sweepUploads,24*60*60*1000).unref();
// Sessions past their expiry can never be used again.
// Also the day's other clean-ups: used or expired reset links, and audit entries over a year old.
const purgeSessions=()=>{
  db.prepare("DELETE FROM sessions WHERE expires_at<=datetime('now')").run();
  db.prepare("DELETE FROM password_resets WHERE used_at IS NOT NULL OR expires_at<=datetime('now')").run();
  db.prepare("DELETE FROM audit_log WHERE at<datetime('now','-365 days')").run();
  // Keeps the query planner's statistics fresh as the tables grow (cheap; only re-analyses what changed).
  db.exec('PRAGMA optimize');
};

purgeSessions();
setInterval(purgeSessions,24*60*60*1000).unref();
// Phone notifications sent once a day (at PUSH_HOUR, UTC): challenges starting tomorrow, with two days left, or on
// their last day; and on Mondays, each person's week in their busiest running challenge.
const PUSH_HOUR=Number(process.env.PUSH_HOUR||8);
async function dailyPushes(force=false){
  if(!pushEnabled.android&&!pushEnabled.ios)return;
  const today=new Date().toISOString().slice(0,10);
  if(!force&&(new Date().getUTCHours()<PUSH_HOUR||getSetting('push_daily')===today))return;
  setSetting('push_daily',today);
  const members=cid=>db.prepare('SELECT user_id FROM challenge_members WHERE challenge_id=?').all(cid).map(r=>r.user_id);
  for(const c of db.prepare("SELECT id,name FROM challenges WHERE start_date=date('now','+1 day')").all())
    await pushTo(members(c.id),{title:`${c.name} starts tomorrow`,body:'Get ready - everything you log from tomorrow counts.',url:`/challenges/${c.id}`});
  for(const c of db.prepare("SELECT id,name FROM challenges WHERE end_date=date('now','+2 days')").all())
    await pushTo(members(c.id),{title:`Two days left in ${c.name}`,body:"Time for a final push - and don't forget to log everything.",url:`/challenges/${c.id}`});
  for(const c of db.prepare("SELECT id,name FROM challenges WHERE end_date=date('now')").all())
    await pushTo(members(c.id),{title:`Last day of ${c.name}`,body:'Log anything that’s missing before midnight.',url:`/challenges/${c.id}`});
  if(new Date().getUTCDay()!==1)return;
  // Monday: last week in the running challenge each person was busiest in (or a nudge in one they're in).
  const people=db.prepare('SELECT DISTINCT d.user_id FROM push_devices d JOIN users us ON us.id=d.user_id WHERE us.notify_push=1 AND us.deactivated_at IS NULL').all().map(r=>r.user_id);
  for(const uid of people){
    const running=db.prepare("SELECT c.* FROM challenges c JOIN challenge_members cm ON cm.challenge_id=c.id WHERE cm.user_id=? AND c.start_date<=date('now') AND c.end_date>=date('now','-1 day')").all(uid);
    if(!running.length)continue;
    const week=c=>db.prepare("SELECT COALESCE(SUM(minutes),0) m,COALESCE(SUM(distance_m),0) d,COALESCE(SUM(steps),0) s,COUNT(*) n FROM activities WHERE user_id=? AND challenge_id=? AND activity_date>=date('now','-7 days') AND activity_date<date('now')").get(uid,c.id);
    const best=running.map(c=>({c,w:week(c)})).sort((a,b)=>b.w.n-a.w.n)[0];
    const {c,w}=best,metric=challengeMetric(c),amount=metric==='distance'?`${metersToUnit(w.d,challengeUnit(c))} ${challengeUnit(c)==='km'?'km':'miles'}`:metric==='steps'?`${Number(w.s).toLocaleString('en-GB')} steps`:`${w.m} minutes`;
    const lb=leaderboard(c),i=lb.users.findIndex(r=>r.id===uid);
    await pushTo([uid],w.n?{title:`Your week in ${c.name}`,body:`You logged ${amount}${i>=0?` - you're ${ordinal(i+1)} of ${lb.users.length}`:''}. Keep it up!`,url:`/challenges/${c.id}`}
      :{title:`New week in ${c.name}`,body:'Nothing logged last week - a short walk counts. Log one today?',url:`/challenges/${c.id}`});
  }
}
const ordinal=n=>n+(n%100>=11&&n%100<=13?'th':['th','st','nd','rd'][n%10]||'th');
setInterval(()=>dailyPushes().catch(e=>console.error('Daily notifications failed',e)),15*60_000).unref();

const send=(res,status,data,headers={})=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store',...headers});res.end(JSON.stringify(data))};
// 1MB default cap on every request body; the image upload route raises it explicitly, since a
// base64 data URL runs ~33% larger than the raw image it encodes.
// Keeps reading (and discarding, once over the cap) chunks until the stream actually ends,
// rather than throwing mid-stream and abandoning the rest on the socket - an early throw here
// used to leave an oversized request's tail undrained on a kept-alive connection, which then
// corrupted whatever request the client's next fetch() reused that same socket for.
const bodyText=async(req,maxBytes=1e6)=>{
  let s='',tooLarge=false;
  for await(const c of req){
    if(tooLarge)continue;
    s+=c;
    if(s.length>maxBytes)tooLarge=true;
  }
  if(tooLarge)throw Object.assign(Error('That request is too large'),{status:413});
  return s;
};
const body=async(req,maxBytes)=>{const s=await bodyText(req,maxBytes);if(!s)return {};try{const v=JSON.parse(s);return v&&typeof v==='object'?v:{}}catch(e){throw Object.assign(Error('The request body must be JSON'),{status:400})}};
// The Apple Shortcut's date, however Shortcuts wrote it: 2026-10-07, 2026-10-07T00:00:00+01:00,
// "7 Oct 2026", "7 October 2026 at 00:00" or "Oct 7, 2026". Null if it can't be read (numbers-only
// forms like 07/10/2026 are left out: day and month could be either way round).
const MONTHS=['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
function shortcutDate(v){
  const t=String(v??'').trim();
  let m=t.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if(m)return `${m[1]}-${m[2]}-${m[3]}`;
  const ymd=(d,mon,y)=>{const i=MONTHS.indexOf(mon.slice(0,3).toLowerCase());return i<0?null:`${y}-${String(i+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`};
  if((m=t.match(/\b(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3,})\.?,?\s+(\d{4})\b/)))return ymd(m[1],m[2],m[3]);
  if((m=t.match(/\b([A-Za-z]{3,})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\b/)))return ymd(m[2],m[1],m[3]);
  return null;
}
// Text a spreadsheet would run as a formula (=, +, -, @, tab, CR first) is prefixed with ' so it shows as text.
const csvEscape=v=>{let s=String(v??'');if(typeof v==='string'&&/^[=+\-@\t\r]/.test(s))s="'"+s;return /[",\r\n]/.test(s)?'"'+s.replace(/"/g,'""')+'"':s};
const cookies=req=>Object.fromEntries((req.headers.cookie||'').split(';').filter(Boolean).map(x=>x.trim().split('=')));
function sessionToken(req){const bearer=(req.headers.authorization||'').match(/^Bearer (.+)$/i);return bearer?.[1]||cookies(req).session||null}
// Lifetimes from the last use: 30 days on the web, 90 in the apps (automatic sync keeps an app signed in).
const SESSION_DAYS={web:30,app:90};
// However often it's used, a session ends in the end: six months on the website, a year in the apps.
const SESSION_MAX_DAYS={web:182,app:365};
// Global admins can see and change everything, so their powers need two-step sign-in (ADMIN_TWO_FACTOR=optional
// turns that off, for local testing). Until it's on they're treated as members, with a reminder.
const ADMIN_TWO_FACTOR_REQUIRED=process.env.ADMIN_TWO_FACTOR!=='optional';
// What a session is, for the signed-in devices list: "Firefox on Windows", "Android app"...
function deviceLabel(req,kind){
  const ua=String(req?.headers?.['user-agent']||'');
  if(kind==='app')return /Android|Dalvik/i.test(ua)?'Android app':/iPhone|iPad|iOS|CFNetwork|Darwin/i.test(ua)?'iPhone app':'Phone app';
  const browser=/Edg\//.test(ua)?'Edge':/OPR\//.test(ua)?'Opera':/Firefox\//.test(ua)?'Firefox':/Chrome\//.test(ua)?'Chrome':/Safari\//.test(ua)?'Safari':'A web browser';
  const os=/iPhone|iPad/.test(ua)?'iPhone':/Android/.test(ua)?'Android':/Windows/.test(ua)?'Windows':/CrOS/.test(ua)?'Chromebook':/Mac OS X|Macintosh/.test(ua)?'Mac':/Linux/.test(ua)?'Linux':'';
  return os?`${browser} on ${os}`:browser;
}
function auth(req){
  const t=sessionToken(req);if(!t)return null;
  const th=crypto.createHash('sha256').update(t).digest('hex');
  const u=db.prepare(`SELECT u.id,u.email,u.name,u.role,u.avatar_url,u.bio,u.profile_sharing,(u.totp_secret IS NOT NULL) two_factor,(instr(u.password_hash,':')>0) has_password,u.notify_email,u.notify_admin,u.notify_push,
    (u.email_verified_at IS NOT NULL) email_verified,u.pending_email,s.expires_at,s.kind,s.created_at session_created,s.last_used_at FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>datetime('now') AND u.deactivated_at IS NULL`).get(th);
  if(!u)return null;
  const fromCookie=!/^Bearer /i.test(req.headers.authorization||''),kind=u.kind||(fromCookie?'web':'app'),days=SESSION_DAYS[kind]||30;
  const at=v=>Date.parse(String(v).replace(' ','T')+'Z');
  if(u.session_created&&at(u.session_created)<Date.now()-(SESSION_MAX_DAYS[kind]||182)*864e5){db.prepare('DELETE FROM sessions WHERE token_hash=?').run(th);return null}
  // When it was last used, to the hour, for the signed-in devices list.
  if(!u.last_used_at||at(u.last_used_at)<Date.now()-36e5)db.prepare("UPDATE sessions SET last_used_at=datetime('now') WHERE token_hash=?").run(th);
  if(u.role==='global_admin'&&!u.two_factor&&ADMIN_TWO_FACTOR_REQUIRED){u.role='member';u.admin_needs_two_factor=true}
  Object.defineProperty(u,'sessionHash',{value:th});
  // Extended at most once a day; a web session's cookie is renewed with it (see api()).
  if(Date.parse(String(u.expires_at).replace(' ','T')+'Z')<Date.now()+(days-1)*864e5){
    db.prepare("UPDATE sessions SET expires_at=datetime('now',?),kind=? WHERE token_hash=?").run(`+${days} days`,kind,th);
    if(fromCookie)Object.defineProperty(u,'renewCookie',{value:t});
  }
  delete u.expires_at;delete u.kind;delete u.session_created;delete u.last_used_at;
  return u;
}
// My account as the apps and website show it (as auth() reports it, without the session's details).
function meRow(uid){
  const x=db.prepare("SELECT id,email,name,role,avatar_url,bio,profile_sharing,(totp_secret IS NOT NULL) two_factor,(instr(password_hash,':')>0) has_password,notify_email,notify_admin,notify_push,(email_verified_at IS NOT NULL) email_verified,pending_email FROM users WHERE id=?").get(uid);
  if(x&&x.role==='global_admin'&&!x.two_factor&&ADMIN_TWO_FACTOR_REQUIRED){x.role='member';x.admin_needs_two_factor=true}
  return x;
}
const need=(res,u,roles)=>{if(!u){send(res,401,{error:'Sign in required'});return false}if(roles&&!roles.includes(u.role)){send(res,403,{error:'Not authorised'});return false}return true};
const SECURE=ORIGIN.startsWith('https:')?'; Secure':'';
const setSessionCookie=t=>({'Set-Cookie':`session=${t}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_DAYS.web*86400}${SECURE}`});
const clearSessionCookie={'Set-Cookie':`session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${SECURE}`};
// A reset link for one person. One an admin makes replaces any earlier link; emailed ones don't cancel each
// other, so someone asking repeatedly for a stranger's account can't spoil the link they're about to use.
function makeResetLink(uid,minutes,createdBy=null){
  const t=crypto.randomBytes(32).toString('base64url');
  if(createdBy)db.prepare('DELETE FROM password_resets WHERE user_id=? AND used_at IS NULL').run(uid);
  db.prepare("INSERT INTO password_resets(token_hash,user_id,expires_at,created_by) VALUES(?,?,datetime('now',?),?)").run(sha256hex(t),uid,`+${minutes} minutes`,createdBy);
  return {url:`${ORIGIN}/reset/${t}`,expiresAt:new Date(Date.now()+minutes*6e4).toISOString()};
}
const findReset=t=>t&&db.prepare("SELECT r.token_hash,r.user_id,r.created_by,u.email,u.name FROM password_resets r JOIN users u ON u.id=r.user_id WHERE r.token_hash=? AND r.used_at IS NULL AND r.expires_at>datetime('now') AND u.deactivated_at IS NULL").get(sha256hex(String(t)));
// Put an existing account into a challenge (and optionally a team), as an owner or a global admin does. Someone
// added - rather than joining themselves - is told: by email if they allow it, and on their home page, where
// they can keep it or leave. Returns whether they were new to the challenge.
function addMember(cid,uid,{role='member',teamId=null,by}){
  const existing=challengeAccess(uid,cid);
  try{
    db.exec('BEGIN');
    if(!existing)db.prepare('INSERT INTO challenge_members(challenge_id,user_id,challenge_role,added_by,added_ack) VALUES(?,?,?,?,?)').run(cid,uid,role,by.id,uid===by.id?1:0);
    else if(role==='owner')db.prepare("UPDATE challenge_members SET challenge_role='owner' WHERE challenge_id=? AND user_id=?").run(cid,uid);
    if(teamId)db.prepare("INSERT OR IGNORE INTO team_members(team_id,user_id,team_role) VALUES(?,?,'member')").run(teamId,uid);
    db.exec('COMMIT');
  }catch(e){db.exec('ROLLBACK');throw e}
  audit(by,existing?(role==='owner'?'made owner':'added to team'):'added to challenge',{user:uid,challenge:cid,detail:[role==='owner'&&'as owner',teamId&&`team ${teamId}`].filter(Boolean).join(', ')||null});
  if(!existing&&uid!==by.id){
    const ch=db.prepare('SELECT name FROM challenges WHERE id=?').get(cid);
    pushTo([uid],{title:`${by.name} added you to ${ch.name}`,body:"Open it to start logging - or leave it if you didn't expect this.",url:`/challenges/${cid}`});
    const who=db.prepare('SELECT email,notify_email,deactivated_at,email_verified_at FROM users WHERE id=?').get(uid),c=db.prepare('SELECT name,start_date,end_date FROM challenges WHERE id=?').get(cid);
    if(who&&who.notify_email&&who.email_verified_at&&!who.deactivated_at&&!pushReachable(uid))sendMail({to:who.email,subject:`You've been added to ${c.name} on Active Together`,
      text:`Hello,\n\n${by.name} added you to the challenge "${c.name}" on Active Together (${c.start_date} to ${c.end_date}).\n\nOpen it here: ${ORIGIN}/challenges/${cid}\n\nDidn't expect this? Open the challenge and choose Leave challenge: anything you've logged in it goes with you.\n\nYou can turn these emails off in My account.\n\nActive Together\n${ORIGIN}`});
  }
  return !existing;
}
// Ticket news by email: a reply or status change to the reporter, a new ticket or reporter reply to the global
// admins (each as they allow, at most one email per ticket per person every 10 minutes) - by phone notification
// instead, for anyone who gets those.
function ticketMail(ticketId,toReporter,what){
  const t=db.prepare('SELECT t.id,t.title,t.user_id,u.email,u.notify_email,u.email_verified_at FROM tickets t JOIN users u ON u.id=t.user_id WHERE t.id=?').get(ticketId);
  if(!t)return;
  pushTo(toReporter?[t.user_id]:db.prepare("SELECT id FROM users WHERE role='global_admin' AND notify_admin=1 AND id!=?").all(t.user_id).map(x=>x.id),
    {title:toReporter?'Your support ticket':`Support ticket #${t.id}`,body:`${what}: ${t.title}`,url:`/help/tickets/${t.id}`});
  if(!emailEnabled())return;
  const people=toReporter?(t.notify_email&&t.email_verified_at?[{id:t.user_id,email:t.email}]:[]):db.prepare("SELECT id,email FROM users WHERE role='global_admin' AND deactivated_at IS NULL AND notify_admin=1 AND email_verified_at IS NOT NULL AND id!=?").all(t.user_id);
  for(const p of people){
    if(pushReachable(p.id))continue;
    if(hitRateLimit(`mail:ticket:${t.id}:${p.id}`,1,10*60_000))continue;
    sendMail({to:p.email,subject:`${toReporter?'Your support ticket':'Support ticket'} #${t.id}: ${what}`,
      text:`Hello,\n\n${toReporter?`There's news on your ticket "${t.title}": ${what}.`:`Ticket #${t.id} "${t.title}": ${what}.`}\n\nOpen it here: ${ORIGIN}/help/tickets/${t.id}\n\nYou can turn these emails off in My account.\n\nActive Together\n${ORIGIN}`});
  }
}
// Codes are unique across challenges and teams alike, since one box takes either.
const codeTaken=code=>!!db.prepare('SELECT 1 FROM challenges WHERE invite_code=? UNION ALL SELECT 1 FROM teams WHERE invite_code=? LIMIT 1').get(code,code);
function freeCode(){for(let i=0;i<10;i++){const c=genCode();if(!codeTaken(c))return c}throw new Error('Could not allocate a unique invite code')}
// Why a code someone typed can't be used (null when it can). It goes in links as /join/CODE, so letters and numbers only.
function customCodeProblem(code,current){
  // Six or more, so a chosen code (often a word) can't be found by trying the short ones.
  if(!/^[A-Z0-9]{6,20}$/.test(code))return {status:400,error:'Use 6 to 20 letters and numbers, with no spaces or symbols.'};
  if(code===current)return {status:400,error:"That's already the code. Type a different one."};
  if(codeTaken(code))return {status:409,error:'That code is already used by another challenge or team. Try a different one.'};
  return null;
}
// Join with an invite code: a challenge's, or a team's (which joins its challenge too). What was joined, or null.
function joinWithCode(uid,raw){
  const code=String(raw||'').trim().toUpperCase();if(!code)return null;
  const challenge=db.prepare('SELECT id,name FROM challenges WHERE invite_code=?').get(code);
  if(challenge){db.prepare("INSERT OR IGNORE INTO challenge_members(challenge_id,user_id,challenge_role) VALUES(?,?,'member')").run(challenge.id,uid);return {type:'challenge',challengeId:challenge.id,name:challenge.name}}
  const team=db.prepare('SELECT id,name,challenge_id FROM teams WHERE invite_code=?').get(code);
  if(!team)return null;
  db.prepare("INSERT OR IGNORE INTO challenge_members(challenge_id,user_id,challenge_role) VALUES(?,?,'member')").run(team.challenge_id,uid);
  db.prepare("INSERT OR IGNORE INTO team_members(team_id,user_id,team_role) VALUES(?,?,'member')").run(team.id,uid);
  return {type:'team',challengeId:team.challenge_id,teamId:team.id,name:team.name};
}
// Take someone out of a challenge: their entries in it, team places and membership. Returns entries deleted.
function removeFromChallenge(cid,uid){
  let removed;
  try{
    db.exec('BEGIN');
    removed=db.prepare('DELETE FROM activities WHERE challenge_id=? AND user_id=?').run(cid,uid).changes;
    db.prepare('DELETE FROM team_members WHERE user_id=? AND team_id IN (SELECT id FROM teams WHERE challenge_id=?)').run(uid,cid);
    db.prepare('DELETE FROM challenge_members WHERE challenge_id=? AND user_id=?').run(cid,uid);
    db.exec('COMMIT');
  }catch(e){db.exec('ROLLBACK');throw e}
  pruneRoutes();
  return removed;
}
function startSession(uid,kind='web',req=null){const t=crypto.randomBytes(32).toString('hex'),th=crypto.createHash('sha256').update(t).digest('hex');db.prepare("INSERT INTO sessions(token_hash,user_id,expires_at,kind,created_at,last_used_at,device) VALUES(?,?,datetime('now',?),?,datetime('now'),datetime('now'),?)").run(th,uid,`+${SESSION_DAYS[kind]||30} days`,kind,deviceLabel(req,kind));return t}

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
  if(n>MAX_MINUTES)throw new Error("That's more than 24 hours in one entry - check the minutes");
  return n;
}
// One entry's limits: a day of activity, and further than anyone goes in one go (1,000 km, 621 miles).
const MAX_MINUTES=1440,MAX_DISTANCE_M=1_000_000;
const capDistance=m=>{if(m>MAX_DISTANCE_M)throw new Error("That's further than 1,000 km (621 miles) in one entry - check the distance");return m};
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
    return capDistance(n);
  }
  if(b.distance===undefined)return undefined;
  if(b.distance===null||b.distance==='')return null;
  const unit=b.distance_unit||fallbackUnit;
  if(!METERS_PER[unit])throw new Error('distance_unit must be mi or km');
  const n=Number(b.distance);
  if(!Number.isFinite(n)||n<=0)throw new Error('Distance must be a positive number');
  return capDistance(n*METERS_PER[unit]);
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
// Given route ids, only those are checked (a single deletion, a sync); otherwise every route is, through the
// route_id index rather than by reading every activity.
function pruneRoutes(ids){
  if(ids){
    const list=[...new Set(ids.filter(x=>x!=null))];
    if(list.length)db.prepare(`DELETE FROM routes WHERE id IN (${list.map(()=>'?').join(',')}) AND NOT EXISTS (SELECT 1 FROM activities a WHERE a.route_id=routes.id)`).run(...list);
    return;
  }
  db.prepare('DELETE FROM routes WHERE NOT EXISTS (SELECT 1 FROM activities a WHERE a.route_id=routes.id)').run();
}
// Request bodies that can carry a route get more room than the 1MB default.
const ROUTE_BODY_MAX=8e6;

// An activity counts only if it happened while the challenge was running - a device sync used to
// bring in a month of older workouts. Dates are YYYY-MM-DD strings, so they compare as text.
const DATE_RE=/^\d{4}-\d{2}-\d{2}$/;
// A real calendar date as YYYY-MM-DD (not 2026-02-31, and nothing else in the string).
const isDate=v=>typeof v==='string'&&DATE_RE.test(v)&&new Date(v+'T00:00:00Z').toISOString().slice(0,10)===v;
function challengeDatesError(start,end){
  if(!isDate(start)||!isDate(end))return 'Start and end dates must be real dates (YYYY-MM-DD)';
  if(end<start)return 'The end date must be on or after the start date';
  return null;
}
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
  const challenges=db.prepare(`SELECT c.id,c.name,c.description,c.start_date,c.end_date,c.active,c.invite_code,c.metric,c.distance_unit,c.participation,c.kind,c.journey_mode,c.route_shape,c.route_from,c.route_to,c.route_via,c.route_m,cm.challenge_role,
    CASE WHEN cm.added_ack=0 THEN (SELECT name FROM users WHERE id=cm.added_by) END added_by FROM challenges c JOIN challenge_members cm ON cm.challenge_id=c.id WHERE cm.user_id=? ORDER BY c.start_date DESC`).all(uid);
  // My teams and my totals for every challenge at once, rather than two queries per challenge.
  const teams=db.prepare(`SELECT t.id,t.name,t.invite_code,t.challenge_id,tm.team_role,(SELECT COUNT(*) FROM team_members z WHERE z.team_id=t.id) members FROM team_members tm JOIN teams t ON t.id=tm.team_id WHERE tm.user_id=? ORDER BY t.name`).all(uid);
  const totals=new Map(db.prepare('SELECT challenge_id,COALESCE(SUM(minutes),0) m,COALESCE(SUM(distance_m),0) d,COALESCE(SUM(steps),0) s FROM activities WHERE user_id=? GROUP BY challenge_id').all(uid).map(r=>[r.challenge_id,r]));
  for(const c of challenges){
    c.role=c.challenge_role; delete c.challenge_role;
    c.kind=isJourney(c)?'journey':'standard';c.journey=journeyInfo(c);
    for(const k of ['journey_mode','route_shape','route_from','route_to','route_via','route_m'])delete c[k];
    c.teams=teams.filter(t=>t.challenge_id===c.id).map(({challenge_id,...t})=>t);
    const tot=totals.get(c.id)||{m:0,d:0,s:0};
    c.myMinutes=tot.m;c.mySteps=tot.s;
    c.myDistance=metersToUnit(tot.d,c.distance_unit);
  }
  // Syncing from a phone: a Shortcuts key, or anything synced in the last 30 days (the home page folds its
  // sync help away then).
  const syncing=!!(db.prepare('SELECT 1 FROM sync_keys WHERE user_id=? LIMIT 1').get(uid)||db.prepare("SELECT 1 FROM activities WHERE user_id=? AND source<>'manual' AND activity_date>=date('now','-30 days') LIMIT 1").get(uid));
  for(const c of challenges)if(c.added_by==null)delete c.added_by;
  return {challenges,syncing};
}

// Team and individual standings for one challenge, ranked by whatever it measures. Both totals
// come back either way (minutes, and distance in the challenge's unit) so the page can show the
// secondary figure too; the ORDER BY column is chosen from a fixed pair, never from input.
// Standings are reused until the challenge's standings version moves on (see the triggers above), so a busy
// challenge page isn't re-totalled for every viewer, and a change anywhere else doesn't throw them away.
const standingsCache=new Map(),standingsVersion=db.prepare('SELECT v FROM standings_version WHERE challenge_id=?');
function cachedStandings(kind,c,compute){
  const v=standingsVersion.get(c.id)?.v??0,key=`${kind}:${c.id}`,hit=standingsCache.get(key);
  if(hit&&hit.v===v)return hit.data;
  const data=compute();remember(standingsCache,key,{v,data},1000);return data;
}
function leaderboard(challenge){return cachedStandings('lb',challenge,()=>computeLeaderboard(challenge))}
function computeLeaderboard(challenge){
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
// A paid or keyed place search (LocationIQ, say, which answers like Nominatim): its key, the name of the key's
// parameter, the reply format, and how long to leave between requests (Nominatim's own rule is one a second).
const GEOCODER_KEY=process.env.GEOCODER_KEY||'',GEOCODER_KEY_PARAM=process.env.GEOCODER_KEY_PARAM||'key',GEOCODER_FORMAT=process.env.GEOCODER_FORMAT||'jsonv2';
const GEOCODER_GAP_MS=Number(process.env.GEOCODER_GAP_MS||1100);
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
// Caches keep their newest entries only (a Map remembers insertion order, so the first key is the oldest).
const remember=(map,key,value,max)=>{map.delete(key);map.set(key,value);while(map.size>max)map.delete(map.keys().next().value)};
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
  remember(routeCache,key,{at:Date.now(),route},200);
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
// Whether an edited journey goes the same way as the stored one (same places, shape and mode), so a
// change of labels alone keeps the planned route instead of asking the route planner again.
function sameWay(c,j){
  const key=(from,to,via,shape,mode)=>JSON.stringify([[from,...via,to].map(p=>p&&[+p.lat,+p.lon]),shape,mode]);
  return key(JSON.parse(c.route_from||'null'),JSON.parse(c.route_to||'null'),JSON.parse(c.route_via||'[]'),c.route_shape,c.journey_mode)===key(j.from,j.to,j.via,j.shape,j.mode);
}
function saveJourneyNames(c,j){
  const stops=JSON.parse(c.route_via||'[]').map((s,i)=>({...s,name:j.via[i].name}));
  db.prepare('UPDATE challenges SET route_from=?,route_to=?,route_via=? WHERE id=?').run(JSON.stringify(j.from),JSON.stringify(j.to),JSON.stringify(stops),c.id);
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
    const q=pathAndQuery.replace('format=jsonv2',`format=${GEOCODER_FORMAT}`)+(GEOCODER_KEY?`&${GEOCODER_KEY_PARAM}=${encodeURIComponent(GEOCODER_KEY)}`:'');
    const r=await fetch(GEOCODER_BASE+q,{headers:{'User-Agent':OUTBOUND_UA,'Accept-Language':'en'},signal:AbortSignal.timeout(15000)});
    if(!r.ok)throw new Error('Place search is unavailable just now');
    const data=await r.json();remember(placeCache,pathAndQuery,{at:Date.now(),data},2000);return data;
  });
  geocoderQueue=job.catch(()=>{}).then(()=>new Promise(r=>setTimeout(r,GEOCODER_GAP_MS)));
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
function journeyStandings(c){return cachedStandings('journey',c,()=>computeJourneyStandings(c))}
function computeJourneyStandings(c){
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
// Deleting an account, by its owner or an admin: a challenge they own alone passes to its longest-standing
// member (or is deleted if nobody else is in it), their activity goes, and what they created is credited to heirId.
function deleteAccount(id,heirId){
  try{
    db.exec('BEGIN');
    const solo=db.prepare(`SELECT challenge_id FROM challenge_members cm WHERE cm.user_id=? AND cm.challenge_role='owner'
      AND NOT EXISTS (SELECT 1 FROM challenge_members o WHERE o.challenge_id=cm.challenge_id AND o.challenge_role='owner' AND o.user_id!=?)`).all(id,id);
    for(const {challenge_id:cid} of solo){
      const next=db.prepare('SELECT user_id FROM challenge_members WHERE challenge_id=? AND user_id!=? ORDER BY joined_at,user_id LIMIT 1').get(cid,id);
      if(next)db.prepare("UPDATE challenge_members SET challenge_role='owner' WHERE challenge_id=? AND user_id=?").run(cid,next.user_id);
      else{db.prepare('DELETE FROM activities WHERE challenge_id=?').run(cid);db.prepare('DELETE FROM challenges WHERE id=?').run(cid)}
    }
    db.prepare('DELETE FROM activities WHERE user_id=?').run(id);
    db.prepare('UPDATE challenges SET created_by=? WHERE created_by=?').run(heirId,id);
    db.prepare('UPDATE teams SET created_by=? WHERE created_by=?').run(heirId,id);
    db.prepare('UPDATE invites SET created_by=? WHERE created_by=?').run(heirId,id);
    db.prepare('DELETE FROM users WHERE id=?').run(id);
    db.exec('COMMIT');
  }catch(e){db.exec('ROLLBACK');throw e}
  pruneRoutes();
}
const nowIso=()=>new Date().toISOString().replace('T',' ').slice(0,23);

async function api(req,res,url){
 const ip=clientIp(req),u=auth(req),m=req.method;
 const limited=u?hitRateLimit('user:'+u.id,API_RATE_LIMIT_MAX,API_RATE_LIMIT_WINDOW_MS)|hitRateLimit('net:'+ip,API_NETWORK_RATE_LIMIT_MAX,API_RATE_LIMIT_WINDOW_MS)
   :hitRateLimit('all:'+ip,API_RATE_LIMIT_MAX,API_RATE_LIMIT_WINDOW_MS);
 if(limited)return send(res,429,{error:'Too many requests. Please slow down and try again shortly.'});
 // For the container's health check: the app answers and the database reads.
 if(m==='GET'&&url.pathname==='/api/health'){db.prepare('SELECT 1').get();return send(res,200,{ok:true})}
 if(u&&u.renewCookie)res.setHeader('Set-Cookie',setSessionCookie(u.renewCookie)['Set-Cookie']);
 if(m==='GET'&&url.pathname==='/api/config'){const cap=captchaConfig();return send(res,200,{captcha:cap,recaptchaSiteKey:cap&&cap.provider==='recaptcha'?cap.siteKey:null,shortcutUrl:SHORTCUT_URL||null,inviteOnly:inviteOnly(),passwordResetEmail:emailEnabled(),
   google:GOOGLE_WEB_CLIENT_ID?{clientId:GOOGLE_WEB_CLIENT_ID,iosClientId:GOOGLE_IOS_CLIENT_ID||null}:null,apple:{servicesId:APPLE_SERVICES_ID||null},
   stores:STORES,tiles:{url:TILE_URL,attribution:TILE_ATTRIBUTION,maxZoom:TILE_MAX_ZOOM},
   push:{android:pushEnabled.android?{appId:FCM.appId,apiKey:FCM.apiKey,projectId:FCM_SA.project_id,senderId:FCM.senderId}:null,ios:pushEnabled.ios}})}
 // Forgotten password: always the same answer, so it never says whether an email has an account. The email
 // goes out in the background so the reply takes as long either way.
 if(m==='POST'&&url.pathname==='/api/password/forgot'){
   const b=await body(req),email=String(b.email||'').toLowerCase().trim();
   if(!email)return send(res,400,{error:'Enter your email address'});
   if(loginLimited('forgot',ip,email))return send(res,429,{error:'Too many requests. Please wait a few minutes and try again.'});
   if(!(await verifyCaptcha(b.captchaToken||b.recaptchaToken,ip)))return send(res,400,{error:'Bot check failed. Please try again.'});
   const who=emailEnabled()&&db.prepare('SELECT id FROM users WHERE email=? AND deactivated_at IS NULL').get(email);
   // At most two emails an hour for any one account, however many networks the requests come from. The email
   // names nobody: the address is all it's sent to, and an account's name is whatever whoever made it typed.
   if(who&&db.prepare("SELECT COUNT(*) n FROM password_resets WHERE user_id=? AND created_by IS NULL AND created_at>datetime('now','-1 hour')").get(who.id).n<2){
     const link=makeResetLink(who.id,60);
     sendMail({to:email,subject:'Reset your Active Together password',text:`Hello,\n\nSomeone (hopefully you) asked to reset the password for the Active Together account that uses this email address. To choose a new password, open this link within the next hour:\n\n${link.url}\n\nIf you didn't ask for this, ignore this email: your password stays as it is.\n\nActive Together\n${ORIGIN}`});
   }
   return send(res,200,{ok:true,emailEnabled:emailEnabled()});
 }
 if(url.pathname==='/api/password/reset'&&(m==='GET'||m==='POST')){
   if(hitRateLimit('reset:'+ip,AUTH_RATE_LIMIT_MAX*3,AUTH_RATE_LIMIT_WINDOW_MS))return send(res,429,{error:'Too many attempts. Please wait a few minutes and try again.'});
   const b=m==='POST'?await body(req):{},r=findReset(m==='POST'?b.token:url.searchParams.get('token'));
   if(!r)return send(res,400,{error:'This reset link has expired or has already been used. Ask for a new one.'});
   if(m==='GET')return send(res,200,{ok:true,name:r.name});
   const pwErr=passwordProblem(b.password,{email:r.email,name:r.name});if(pwErr)return send(res,400,{error:pwErr});
   const h=await hash(b.password);
   db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(h,r.user_id);
   // A link that came by email shows the address is theirs.
   if(!r.created_by)db.prepare("UPDATE users SET email_verified_at=COALESCE(email_verified_at,datetime('now')) WHERE id=?").run(r.user_id);
   securityMail(r.user_id,'Your password was reset');
   db.prepare("UPDATE password_resets SET used_at=datetime('now') WHERE token_hash=?").run(r.token_hash);
   db.prepare('DELETE FROM password_resets WHERE user_id=? AND used_at IS NULL').run(r.user_id);
   audit(r.user_id,'password reset',{user:r.user_id});
   // Signed out everywhere: whoever knew the old password is out too.
   db.prepare('DELETE FROM sessions WHERE user_id=?').run(r.user_id);
   console.log(`Password reset for user ${r.user_id}`);
   return send(res,200,{ok:true,email:r.email});
 }
 // Global admins: site settings (for now, whether new accounts need an invite).
 if(url.pathname==='/api/admin/settings'&&(m==='GET'||m==='PATCH')){
   if(!need(res,u,['global_admin']))return;
   if(m==='PATCH'){const b=await body(req);if(b.inviteOnly!==undefined&&!!b.inviteOnly!==inviteOnly()){setSetting('invite_only',b.inviteOnly?'1':'0');audit(u,b.inviteOnly?'invite only on':'invite only off')}}
   return send(res,200,{inviteOnly:inviteOnly()});
 }
 // Creating an account: on the website (with the bot check, the session in a cookie) or in the apps (no web
 // page to show a bot check in, so they rely on the sign-up rate limit - and the invite when the site is
 // invite only - as the app sign-in does; the session comes back as a token).
 if(m==='POST'&&(url.pathname==='/api/register'||url.pathname==='/api/mobile/register')){
   const app=url.pathname==='/api/mobile/register';
   if(hitRateLimit('register:'+ip,REGISTER_RATE_LIMIT_MAX,AUTH_RATE_LIMIT_WINDOW_MS))return send(res,429,{error:'Too many registration attempts from this network. Please try again later.'});
   const b=await body(req),email=String(b.email||'').toLowerCase().trim(),name=String(b.name||'').trim();
   if(!name||!email||!b.password)return send(res,400,{error:'Name, email and a password of at least 8 characters are required'});
   const fieldErr=tooLong(name,MAX_LEN.person,'your name')||(!validEmail(email)&&'Enter a valid email address')||passwordProblem(b.password,{email,name});
   if(fieldErr)return send(res,400,{error:fieldErr});
   if(b.invite_code&&codeGuessBlocked(ip))return send(res,429,CODE_BLOCKED);
   // Invite only: a new account needs the invite code (or emailed invite) someone shared.
   if(inviteOnly()&&!validInvite(b.invite_code,b.invite_token)){if(b.invite_code)noteBadCode(ip);return send(res,403,{error:b.invite_code?"That invite code wasn't recognised. Check it, or ask for a new invite link.":'Active Together is invite only. Use the invite link or code someone sent you to create an account.',inviteRequired:true})}
   if(!app&&!(await verifyCaptcha(b.captchaToken||b.recaptchaToken,ip)))return send(res,400,{error:'Bot check failed. Please try again.'});
   // On the website the session is only ever in the cookie (HttpOnly): page scripts never see it.
   try{const r=db.prepare("INSERT INTO users(email,name,password_hash,role) VALUES(?,?,?,'member')").run(email,name,await hash(b.password));const uid=Number(r.lastInsertRowid),t=startSession(uid,app?'app':'web',req),user={id:uid,email,name,role:'member',email_verified:false};
     sendEmailCheck(uid,email);
     // An invite code given when signing up (typed, or from the invite link) joins that challenge straight away.
     const joined=joinWithCode(uid,b.invite_code);
     if(b.invite_code&&!joined)noteBadCode(ip,uid);
     return app?send(res,201,{ok:true,sessionToken:t,user,joined}):send(res,201,{ok:true,user,joined},setSessionCookie(t))}catch(e){if(isUniqueViolation(e))return send(res,409,{error:'An account with that email already exists'});throw e}
 }
 if(m==='POST'&&url.pathname==='/api/login'){
   const b=await body(req);
   if(loginLimited('login',ip,b.email))return send(res,429,{error:'Too many sign-in attempts. Please wait a few minutes and try again.'});
   if(!(await verifyCaptcha(b.captchaToken||b.recaptchaToken,ip)))return send(res,400,{error:'Bot check failed. Please try again.'});
   const result=await attemptLogin(b.email,b.password,'web',req);
   if(!result)return send(res,401,{error:'Invalid email or password'});
   if(result.deactivated)return send(res,403,{error:DEACTIVATED_MSG});
   if(result.twoFactor)return send(res,200,{twoFactor:true,ticket:result.ticket});
   return send(res,200,{ok:true,user:result.user},setSessionCookie(result.sessionToken));
 }
 // Signing in with Google or Apple (website: cookie; apps: token). A known Google/Apple account signs straight
 // in. Otherwise, when the provider vouches for the email and an account already uses it, the two are linked -
 // and every other session on that account ends, in case someone else had registered that email with a
 // password of their own. Otherwise a new account is made (with the invite code, if the site is invite only).
 // Two-step sign-in still applies.
 if(m==='POST'&&url.pathname.match(/^\/api\/(mobile\/)?auth\/(google|apple)$/)){
   const app=url.pathname.startsWith('/api/mobile/'),provider=url.pathname.split('/').pop(),label=SOCIAL[provider].label;
   if(!SOCIAL[provider].audiences().length||(provider==='google'&&!GOOGLE_WEB_CLIENT_ID))return send(res,404,{error:`Signing in with ${label} isn't set up here`});
   if(hitRateLimit('social:'+ip,AUTH_RATE_LIMIT_MAX*5,AUTH_RATE_LIMIT_WINDOW_MS))return send(res,429,{error:'Too many sign-in attempts. Please wait a few minutes and try again.'});
   const b=await body(req);
   let claims;
   try{claims=await verifyIdToken(provider,b.credential)}catch(e){return send(res,401,{error:`Signing in with ${label} didn't work. Please try again.`})}
   const verified=claims.email_verified===true||claims.email_verified==='true',email=verified&&claims.email?String(claims.email).toLowerCase().trim():null;
   let user=db.prepare('SELECT u.* FROM identities i JOIN users u ON u.id=i.user_id WHERE i.provider=? AND i.sub=?').get(provider,String(claims.sub)),linked=false,created=false,takenOver=false;
   if(!user&&email){
     user=db.prepare('SELECT * FROM users WHERE email=?').get(email);
     if(user){
       db.prepare('INSERT OR IGNORE INTO identities(provider,sub,user_id,email) VALUES(?,?,?,?)').run(provider,String(claims.sub),user.id,email);linked=true;
       // Nobody had shown this address was theirs, and the provider just has: whoever made the account may not own it,
       // so its password, two-step sign-in and phone sync keys go (the owner can set a password again in My account).
       if(!user.email_verified_at){
         db.prepare("UPDATE users SET password_hash=?,totp_secret=NULL,totp_pending=NULL,totp_last_step=NULL,email_verified_at=datetime('now'),pending_email=NULL WHERE id=?").run(NO_PASSWORD,user.id);
         db.prepare('DELETE FROM totp_backup_codes WHERE user_id=?').run(user.id);db.prepare('DELETE FROM sync_keys WHERE user_id=?').run(user.id);
         audit(user.id,`${label} sign-in took over an unconfirmed account`,{user:user.id,detail:'password and two-step sign-in removed'});
         user=db.prepare('SELECT * FROM users WHERE id=?').get(user.id);takenOver=true;
       }
       securityMail(user.id,`Signing in with ${label} was linked to your account`);
     }
   }
   if(!user){
     if(!email)return send(res,400,{error:`${label} didn't share an email address, which an account needs. Try again and allow it, or create an account with your email.`});
     if(b.invite_code&&codeGuessBlocked(ip))return send(res,429,CODE_BLOCKED);
     const invited=!inviteOnly()||validInvite(b.invite_code,b.invite_token);
     if(!invited&&b.invite_code)noteBadCode(ip);
     if(!invited)return send(res,403,{error:b.invite_code?"That invite code wasn't recognised. Check it, or ask for a new invite link.":'Active Together is invite only. Enter the invite code someone sent you to create your account.',inviteRequired:true});
     if(hitRateLimit('register:'+ip,REGISTER_RATE_LIMIT_MAX,AUTH_RATE_LIMIT_WINDOW_MS))return send(res,429,{error:'Too many new accounts from this network. Please try again later.'});
     const name=String(b.name||claims.name||[claims.given_name,claims.family_name].filter(Boolean).join(' ')||email.split('@')[0]).trim().slice(0,80);
     const r=db.prepare("INSERT INTO users(email,name,password_hash,role,email_verified_at) VALUES(?,?,?,'member',datetime('now'))").run(email,name,NO_PASSWORD);
     db.prepare('INSERT INTO identities(provider,sub,user_id,email) VALUES(?,?,?,?)').run(provider,String(claims.sub),Number(r.lastInsertRowid),email);
     user=db.prepare('SELECT * FROM users WHERE id=?').get(Number(r.lastInsertRowid));created=true;
   }
   if(user.deactivated_at)return send(res,403,{error:DEACTIVATED_MSG});
   if(linked){db.prepare('DELETE FROM sessions WHERE user_id=?').run(user.id);audit(user.id,`${label} sign-in linked`,{user:user.id,detail:'other sessions signed out'})}
   // Two-step sign-in first: the invite code is sent again with the code, and only used once that's done.
   if(user.totp_secret)return send(res,200,{twoFactor:true,ticket:makeLoginTicket(user.id,app?'app':'web')});
   // An invite code that came with it (typed, or from the invite link) joins that challenge.
   const joined=b.invite_code?joinWithCode(user.id,b.invite_code):null;
   if(b.invite_code&&!joined)noteBadCode(ip,user.id);
   const t=startSession(user.id,app?'app':'web',req),out={ok:true,created,linked,takenOver,joined,user:{id:user.id,email:user.email,name:user.name,role:user.role,avatarUrl:user.avatar_url}};
   return app?send(res,created?201:200,{...out,sessionToken:t}):send(res,created?201:200,out,setSessionCookie(t));
 }
 // My Google / Apple sign-ins: listed in My account; one can be removed while there's still a way in (a
 // password, or another).
 if(url.pathname.match(/^\/api\/me\/identities(\/(google|apple))?$/)&&(m==='GET'||m==='DELETE')){
   if(!need(res,u))return;
   const list=()=>db.prepare('SELECT provider,email,created_at FROM identities WHERE user_id=? ORDER BY provider').all(u.id);
   if(m==='GET')return send(res,200,{identities:list(),has_password:!!u.has_password});
   const provider=url.pathname.split('/').pop(),mine=list();
   if(!mine.some(i=>i.provider===provider))return send(res,404,{error:'Not linked'});
   if(!u.has_password&&mine.length<2)return send(res,400,{error:'Set a password first, so you can still sign in'});
   db.prepare('DELETE FROM identities WHERE user_id=? AND provider=?').run(u.id,provider);
   securityMail(u.id,`Signing in with ${SOCIAL[provider].label} was removed from your account`);
   return send(res,200,{ok:true,identities:list()});
 }
 // Confirming an email address with the link we sent (signed in or not: having the link is what counts). The link
 // for a new address also makes the change.
 if(m==='POST'&&url.pathname==='/api/email/verify'){
   if(hitRateLimit('verify:'+ip,AUTH_RATE_LIMIT_MAX*3,AUTH_RATE_LIMIT_WINDOW_MS))return send(res,429,{error:'Too many attempts. Please wait a few minutes and try again.'});
   const b=await body(req),row=db.prepare("SELECT c.user_id,c.email,us.email current FROM email_checks c JOIN users us ON us.id=c.user_id WHERE c.token_hash=? AND c.expires_at>datetime('now')").get(sha256hex(String(b.token||'')));
   if(!row)return send(res,400,{error:'This link has expired or has already been used. You can ask for a new one in My account.'});
   if(row.email!==row.current){
     if(db.prepare('SELECT 1 FROM users WHERE email=? AND id!=?').get(row.email,row.user_id))return send(res,409,{error:'Another account uses that email address now, so it can’t be changed to it.'});
     db.prepare("UPDATE users SET email=?,pending_email=NULL,email_verified_at=datetime('now') WHERE id=?").run(row.email,row.user_id);
     audit(row.user_id,'email changed',{user:row.user_id});
     securityMail(row.user_id,`The email address was changed to ${row.email}`,{to:row.current});
   }else db.prepare("UPDATE users SET email_verified_at=COALESCE(email_verified_at,datetime('now')) WHERE id=?").run(row.user_id);
   db.prepare('DELETE FROM email_checks WHERE user_id=?').run(row.user_id);
   return send(res,200,{ok:true,email:row.email,changed:row.email!==row.current});
 }
 // Send the confirming link again (to the new address, while a change is waiting).
 if(m==='POST'&&url.pathname==='/api/me/email/resend'){
   if(!need(res,u))return;
   if(!emailEnabled())return send(res,400,{error:"This site can't send email at the moment"});
   if(u.email_verified&&!u.pending_email)return send(res,400,{error:'Your email address is already confirmed'});
   if(hitRateLimit('resend:'+u.id,3,60*60_000))return send(res,429,{error:'We’ve sent a few already - check your spam folder, or try again in an hour.'});
   sendEmailCheck(u.id,u.pending_email||u.email,{change:!!u.pending_email});
   return send(res,200,{ok:true,to:u.pending_email||u.email});
 }
 // Phone notifications: an app registers its push token (tied to this session, so signing it out stops them), or
 // removes it on signing out.
 if(url.pathname==='/api/me/push'&&(m==='POST'||m==='DELETE')){
   if(!need(res,u))return;
   const b=await body(req),token=String(b.token||'').trim(),platform=b.platform==='ios'?'ios':b.platform==='android'?'android':null;
   if(!token||token.length>4096)return send(res,400,{error:'token required'});
   if(m==='DELETE'){db.prepare('DELETE FROM push_devices WHERE token=? AND user_id=?').run(token,u.id);return send(res,200,{ok:true})}
   if(!platform)return send(res,400,{error:'platform must be android or ios'});
   db.prepare('INSERT INTO push_devices(token,user_id,platform,session_hash) VALUES(?,?,?,?) ON CONFLICT(token) DO UPDATE SET user_id=excluded.user_id,platform=excluded.platform,session_hash=excluded.session_hash').run(token,u.id,platform,u.sessionHash);
   return send(res,200,{ok:true,enabled:pushEnabled[platform]});
 }
 // My signed-in devices: each website or app session, with sign-out for any one, or for all but this one.
 if(url.pathname.match(/^\/api\/me\/sessions(\/[a-f0-9]{16}|\/others)?$/)&&(m==='GET'||m==='DELETE')){
   if(!need(res,u))return;
   const id=url.pathname.split('/')[4];
   if(m==='GET')return send(res,200,{sessions:db.prepare("SELECT substr(token_hash,1,16) id,kind,device,created_at,last_used_at FROM sessions WHERE user_id=? AND expires_at>datetime('now') ORDER BY COALESCE(last_used_at,created_at) DESC").all(u.id)
     .map(x=>({...x,device:x.device||(x.kind==='app'?'Phone app':'A web browser'),current:u.sessionHash.startsWith(x.id)}))});
   if(!id)return send(res,400,{error:'Which session?'});
   const n=id==='others'?db.prepare('DELETE FROM sessions WHERE user_id=? AND token_hash!=?').run(u.id,u.sessionHash).changes
     :db.prepare("DELETE FROM sessions WHERE user_id=? AND substr(token_hash,1,16)=?").run(u.id,id).changes;
   if(id==='others'&&n)securityMail(u.id,`${n} other device${n===1?' was':'s were'} signed out`);
   const self=id!=='others'&&u.sessionHash.startsWith(id);
   return send(res,200,{ok:true,signedOut:n},self&&!/^Bearer /i.test(req.headers.authorization||'')?clearSessionCookie:{});
 }
 // The second step of signing in: the code from the authenticator app (or a backup code), with the ticket the
 // password step gave. A few tries per account, then a wait.
 if(m==='POST'&&(url.pathname==='/api/login/2fa'||url.pathname==='/api/mobile/login/2fa')){
   const b=await body(req),app=url.pathname.startsWith('/api/mobile/'),uid=readLoginTicket(b.ticket,app?'app':'web');
   if(!uid)return send(res,400,{error:'That sign-in has expired. Please enter your email and password again.',restart:true});
   if(hitRateLimit('2fa:'+uid,6,10*60_000))return send(res,429,{error:'Too many codes tried. Please wait 10 minutes and try again.'});
   const x=db.prepare('SELECT * FROM users WHERE id=?').get(uid);
   if(!x||x.deactivated_at||!x.totp_secret)return send(res,400,{error:'That sign-in has expired. Please enter your email and password again.',restart:true});
   if(!checkSecondFactor(x,b.code))return send(res,401,{error:"That code didn't work. Use the newest code from your authenticator app, or a backup code."});
   const t=startSession(uid,app?'app':'web',req),user={id:x.id,email:x.email,name:x.name,role:x.role,avatarUrl:x.avatar_url};
   // Signing in from an invite link: join now that the sign-in is complete.
   const joined=b.invite_code&&!codeGuessBlocked(ip,uid)?joinWithCode(uid,b.invite_code):null;
   if(b.invite_code&&!joined)noteBadCode(ip,uid);
   return app?send(res,200,{ok:true,sessionToken:t,user,joined}):send(res,200,{ok:true,user,joined},setSessionCookie(t));
 }
 // Bearer-token login for the Android/iOS companion apps, which have no web page to render a
 // captcha widget in. Deliberately not recaptcha-gated; relies on the same per-IP rate limit
 // below plus the normal password check for abuse resistance instead.
 if(m==='POST'&&url.pathname==='/api/mobile/login'){
   const b=await body(req);
   if(loginLimited('mobilelogin',ip,b.email))return send(res,429,{error:'Too many sign-in attempts. Please wait a few minutes and try again.'});
   const result=await attemptLogin(b.email,b.password,'app',req);
   if(!result)return send(res,401,{error:'Invalid email or password'});
   if(result.deactivated)return send(res,403,{error:DEACTIVATED_MSG});
   if(result.twoFactor)return send(res,200,{twoFactor:true,ticket:result.ticket});
   return send(res,200,{ok:true,...result});
 }
 if(m==='POST'&&url.pathname==='/api/logout'){if(u){const t=sessionToken(req);db.prepare('DELETE FROM sessions WHERE token_hash=?').run(crypto.createHash('sha256').update(t).digest('hex'))}return send(res,200,{ok:true},clearSessionCookie)}
 if(m==='GET'&&url.pathname==='/api/me')return send(res,200,{user:u});
 if(m==='PATCH'&&url.pathname==='/api/me'){
   if(!need(res,u))return;
   const b=await body(req);
   const name=b.name!==undefined?String(b.name).trim():undefined;
   if(name!==undefined&&!name)return send(res,400,{error:'Name cannot be empty'});
   if(name!==undefined&&name.length>MAX_LEN.person)return send(res,400,{error:tooLong(name,MAX_LEN.person,'your name')});
   let email=b.email!==undefined?String(b.email).toLowerCase().trim():undefined;
   if(email!==undefined&&!email)return send(res,400,{error:'Email cannot be empty'});
   // Sending the address it already has cancels a change waiting to be confirmed.
   if(email===u.email){if(u.pending_email){db.prepare('UPDATE users SET pending_email=NULL WHERE id=?').run(u.id);db.prepare('DELETE FROM email_checks WHERE user_id=?').run(u.id)}email=undefined}
   if(email!==undefined&&!validEmail(email))return send(res,400,{error:'Enter a valid email address'});
   if(email!==undefined&&db.prepare('SELECT 1 FROM users WHERE email=? AND id!=?').get(email,u.id))return send(res,409,{error:'An account with that email already exists'});
   if(b.newPassword){const pwErr=passwordProblem(b.newPassword,{email:u.email,name:name||u.name});if(pwErr)return send(res,400,{error:pwErr})}
   const changingSensitive=email!==undefined||!!b.newPassword;
   if(changingSensitive){
     const current=db.prepare('SELECT password_hash FROM users WHERE id=?').get(u.id);
     // Signed up with Google or Apple: there's no password to give, so one can be set; the email waits for it.
     if(!hasPassword(current.password_hash)){if(email!==undefined)return send(res,400,{error:'Set a password first, then you can change your email'})}
     else if(!b.currentPassword||!(await verify(b.currentPassword,current.password_hash)))return send(res,400,{error:'Current password is required and must be correct to change your email or password'});
   }
   let passwordHash;
   if(b.newPassword)passwordHash=await hash(b.newPassword);
   // A new address is used once it's confirmed (where email can be sent); the old one hears about it either way.
   let pendingEmail=null;
   if(email!==undefined&&emailEnabled()){pendingEmail=email;email=undefined}
   let avatarUrl;
   try{avatarUrl=validateImageUrl(b.avatarUrl)}catch(e){return send(res,400,{error:e.message})}
   const bio=b.bio!==undefined?(String(b.bio).trim().slice(0,280)||null):undefined;
   const sharing=b.profileSharing;
   if(sharing!==undefined&&!PROFILE_SHARING.includes(sharing))return send(res,400,{error:'profileSharing must be private, summary or full'});
   if(b.notifyEmail!==undefined)db.prepare('UPDATE users SET notify_email=? WHERE id=?').run(b.notifyEmail?1:0,u.id);
   if(b.notifyAdmin!==undefined)db.prepare('UPDATE users SET notify_admin=? WHERE id=?').run(b.notifyAdmin?1:0,u.id);
   if(b.notifyPush!==undefined)db.prepare('UPDATE users SET notify_push=? WHERE id=?').run(b.notifyPush?1:0,u.id);
   if(pendingEmail){
     db.prepare('UPDATE users SET pending_email=? WHERE id=?').run(pendingEmail,u.id);
     sendEmailCheck(u.id,pendingEmail,{change:true});
     securityMail(u.id,`Someone asked to change the email address to ${pendingEmail} (it changes once the new address is confirmed)`);
   }
   if(email!==undefined)db.prepare('UPDATE users SET email_verified_at=NULL WHERE id=?').run(u.id);
   try{
     const profileChanged=bio!==undefined||sharing!==undefined||b.notifyEmail!==undefined||b.notifyAdmin!==undefined||b.notifyPush!==undefined||!!pendingEmail;
     if(bio!==undefined)db.prepare('UPDATE users SET bio=? WHERE id=?').run(bio,u.id);
     if(sharing!==undefined)db.prepare('UPDATE users SET profile_sharing=? WHERE id=?').run(sharing,u.id);
     if(!updateUserFields(u.id,{name,email,passwordHash,avatarUrl})&&!profileChanged)return send(res,400,{error:'Nothing to update'});
   }catch(e){if(isUniqueViolation(e))return send(res,409,{error:'An account with that email already exists'});throw e}
   if(passwordHash){const t=sessionToken(req);db.prepare('DELETE FROM sessions WHERE user_id=? AND token_hash!=?').run(u.id,crypto.createHash('sha256').update(t).digest('hex'));securityMail(u.id,u.has_password?'Your password was changed':'A password was set')}
   if(email!==undefined)securityMail(u.id,`The email address was changed to ${email}`,{to:u.email});
   return send(res,200,{ok:true,user:meRow(u.id)});
 }
 // Two-step sign-in for my account: set up (a new secret to scan), switch on with a first code (which returns
 // the backup codes), new backup codes, or switch off (password needed for both of those).
 if(m==='POST'&&url.pathname.match(/^\/api\/me\/2fa\/(setup|enable|disable|backup-codes)$/)){
   if(!need(res,u))return;
   const step=url.pathname.split('/').pop(),b=await body(req),x=db.prepare('SELECT * FROM users WHERE id=?').get(u.id);
   if(step==='setup'){
     if(x.totp_secret)return send(res,400,{error:'Two-step sign-in is already on'});
     const secret=b32encode(crypto.randomBytes(20));
     db.prepare('UPDATE users SET totp_pending=? WHERE id=?').run(sealSecret(secret),u.id);
     const label=encodeURIComponent(`Active Together:${x.email}`);
     return send(res,200,{secret,uri:`otpauth://totp/${label}?secret=${secret}&issuer=Active%20Together&digits=6&period=30`});
   }
   if(step==='enable'){
     if(x.totp_secret)return send(res,400,{error:'Two-step sign-in is already on'});
     const pending=openSecret(x.totp_pending),at=pending&&totpStep(pending,b.code,0);
     if(!at)return send(res,400,{error:"That code didn't match. Check the time on your phone is right, and use the newest code."});
     db.prepare('UPDATE users SET totp_secret=totp_pending,totp_pending=NULL,totp_last_step=? WHERE id=?').run(at,u.id);
     audit(u,'two-step sign-in on',{user:u.id});
     securityMail(u.id,'Two-step sign-in was turned on');
     return send(res,200,{ok:true,backupCodes:newBackupCodes(u.id)});
   }
   if(!hasPassword(x.password_hash))return send(res,400,{error:'Set a password in My account first'});
   if(!b.password||!(await verify(String(b.password),x.password_hash)))return send(res,400,{error:'Enter your current password'});
   if(!x.totp_secret)return send(res,400,{error:'Two-step sign-in is off'});
   if(step==='backup-codes'){securityMail(u.id,'New two-step sign-in backup codes were made (the old ones no longer work)');return send(res,200,{ok:true,backupCodes:newBackupCodes(u.id)})}
   db.prepare('UPDATE users SET totp_secret=NULL,totp_pending=NULL,totp_last_step=NULL WHERE id=?').run(u.id);
   db.prepare('DELETE FROM totp_backup_codes WHERE user_id=?').run(u.id);
   audit(u,'two-step sign-in off',{user:u.id});
   securityMail(u.id,'Two-step sign-in was turned off');
   return send(res,200,{ok:true});
 }
 if(m==='POST'&&url.pathname==='/api/uploads'){
   if(hitRateLimit('upload:'+ip,UPLOAD_RATE_LIMIT_MAX,UPLOAD_RATE_LIMIT_WINDOW_MS))return send(res,429,{error:'Too many uploads. Please slow down.'});
   if(!need(res,u))return;
   let b;
   try{b=await body(req,Math.ceil(UPLOAD_MAX_BYTES*4/3)+2048)}catch(e){return send(res,413,{error:'Image is too large (max 3MB).'})}
   const dm=String(b.dataUrl||'').match(/^data:image\/[a-z]+;base64,(.+)$/i);
   if(!dm)return send(res,400,{error:'A valid image data URL is required'});
   const buf=Buffer.from(dm[1],'base64');
   if(buf.length>UPLOAD_MAX_BYTES)return send(res,413,{error:'Image is too large (max 3MB).'});
   const detected=detectImageType(buf);
   if(!detected)return send(res,400,{error:'Unrecognised image format. Use PNG, JPEG, GIF or WEBP.'});
   const filename=`${crypto.randomBytes(16).toString('hex')}.${detected.ext}`;
   fs.writeFileSync(path.join(UPLOADS_DIR,filename),buf);
   return send(res,201,{url:`/uploads/${filename}`});
 }
 if(m==='GET'&&url.pathname==='/api/dashboard'){if(!need(res,u))return;return send(res,200,{user:u,...dashboard(u.id)})}
 // Keep a challenge someone else added me to (the home page stops asking).
 if(m==='POST'&&url.pathname.match(/^\/api\/challenges\/\d+\/ack$/)){if(!need(res,u))return;db.prepare('UPDATE challenge_members SET added_ack=1 WHERE challenge_id=? AND user_id=?').run(Number(url.pathname.split('/')[3]),u.id);return send(res,200,{ok:true})}
 if(m==='GET'&&url.pathname==='/api/mobile/bootstrap'){if(!need(res,u))return;return send(res,200,{user:u,...dashboard(u.id),health:{healthConnect:{platform:'Android',mode:'native-companion-required'},healthKit:{platform:'iOS',mode:'native-companion-required'},acceptedRecord:'exercise session duration and distance',uploadEndpoint:'/api/health/import'}})}

 if(m==='POST'&&url.pathname==='/api/challenges'){
   if(!need(res,u))return;
   const b=await body(req);
   if(!b.name||!b.start_date||!b.end_date)return send(res,400,{error:'name, start_date and end_date are required'});
   const datesErr=challengeDatesError(b.start_date,b.end_date);if(datesErr)return send(res,400,{error:datesErr});
   const description=b.description!==undefined?(sanitizeHtml(String(b.description).trim())||null):null;
   const lenErr=tooLong(String(b.name).trim(),MAX_LEN.challenge,'the name')||tooLong(description,MAX_LEN.description,'the description');
   if(lenErr)return send(res,400,{error:lenErr});
   // Planning a journey asks the public route planner, so it shares the route preview's limit.
   if(b.kind==='journey'&&hitRateLimit('routes:'+u.id,40,60_000))return send(res,429,{error:'Too many routes planned - wait a minute and try again'});
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
 if(m==='PATCH'&&url.pathname.match(/^\/api\/challenges\/\d+$/)){if(!need(res,u))return;const cid=Number(url.pathname.split('/')[3]),challenge=db.prepare('SELECT * FROM challenges WHERE id=?').get(cid);if(!challenge)return send(res,404,{error:'Challenge not found'});if(!canManageChallenge(u,cid))return send(res,403,{error:'Only the challenge owner can edit this challenge'});const b=await body(req),name=b.name!==undefined?String(b.name).trim():challenge.name,start_date=b.start_date!==undefined?b.start_date:challenge.start_date,end_date=b.end_date!==undefined?b.end_date:challenge.end_date,description=b.description!==undefined?(sanitizeHtml(String(b.description).trim())||null):challenge.description;if(!name||!start_date||!end_date)return send(res,400,{error:'name, start_date and end_date are required'});const datesErr=challengeDatesError(start_date,end_date);if(datesErr)return send(res,400,{error:datesErr});const lenErr=tooLong(name,MAX_LEN.challenge,'the name')||tooLong(description,MAX_LEN.description,'the description');if(lenErr)return send(res,400,{error:lenErr});if(b.journey!==undefined&&hitRateLimit('routes:'+u.id,40,60_000))return send(res,429,{error:'Too many routes planned - wait a minute and try again'});let measure,journey=null,route=null;try{measure=parseChallengeMeasure(b);if(b.journey!==undefined||isJourney(challenge)){journey=b.journey!==undefined?parseJourney(b):{mode:challenge.journey_mode};checkJourneyMeasure(measure.metric||challenge.metric,journey.mode);if(b.journey!==undefined){if(isJourney(challenge)&&sameWay(challenge,journey))saveJourneyNames(challenge,journey);else route=await buildRoute(journey)}}}catch(e){return send(res,400,{error:e.message})}if(route)saveJourney(cid,journey,route);db.prepare('UPDATE challenges SET name=?,start_date=?,end_date=?,description=?,metric=?,distance_unit=?,participation=? WHERE id=?').run(name,start_date,end_date,description,measure.metric||challenge.metric,measure.distance_unit||challenge.distance_unit,measure.participation||challenge.participation,cid);return send(res,200,{ok:true})}
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
   audit(u,'deleted challenge',{detail:challenge.name});
   return send(res,200,{ok:true});
 }
 // A new invite code for a challenge or team: the old link and code stop working at once.
 if(m==='POST'&&url.pathname.match(/^\/api\/(challenges|teams)\/\d+\/invite-code$/)){
   if(!need(res,u))return;
   const team=url.pathname.startsWith('/api/teams/'),id=Number(url.pathname.split('/')[3]);
   const row=db.prepare(`SELECT * FROM ${team?'teams':'challenges'} WHERE id=?`).get(id);
   if(!row)return send(res,404,{error:team?'Team not found':'Challenge not found'});
   if(team?!canManageTeam(u,row):!canManageChallenge(u,id))return send(res,403,{error:'Only an owner can change the invite link'});
   // Global admins may choose the code themselves; everyone else gets a made-up one.
   const b=await body(req),wanted=String(b.code??'').trim().toUpperCase();
   let code;
   if(wanted){
     if(u.role!=='global_admin')return send(res,403,{error:'Only a global admin can choose the code'});
     const bad=customCodeProblem(wanted,row.invite_code);
     if(bad)return send(res,bad.status,{error:bad.error});
     code=wanted;
   }else code=freeCode();
   db.prepare(`UPDATE ${team?'teams':'challenges'} SET invite_code=? WHERE id=?`).run(code,id);
   audit(u,'new invite link',{challenge:team?row.challenge_id:id,detail:[team&&`team ${row.name}`,wanted&&`code ${code}`].filter(Boolean).join(', ')||null});
   return send(res,200,{invite_code:code});
 }
 // Global admins: a free code to start from when choosing one.
 if(m==='GET'&&url.pathname==='/api/invite-codes/suggest'){if(!need(res,u,['global_admin']))return;return send(res,200,{code:freeCode()})}
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
 // Who is in a challenge, for its owners and global admins: role, teams and how many entries each has.
 if(m==='GET'&&url.pathname.match(/^\/api\/challenges\/\d+\/members$/)){
   if(!need(res,u))return;
   const cid=Number(url.pathname.split('/')[3]),c=db.prepare('SELECT id,participation FROM challenges WHERE id=?').get(cid);
   if(!c)return send(res,404,{error:'Challenge not found'});
   if(!canManageChallenge(u,cid))return send(res,403,{error:'Only a challenge owner can view this'});
   const members=db.prepare(`SELECT us.id,us.name,us.email,us.avatar_url,us.deactivated_at,cm.challenge_role,cm.challenge_role role,cm.joined_at,
     (SELECT group_concat(t.name,', ') FROM teams t JOIN team_members tm ON tm.team_id=t.id WHERE tm.user_id=us.id AND t.challenge_id=cm.challenge_id) teams,
     (SELECT COUNT(*) FROM activities a WHERE a.user_id=us.id AND a.challenge_id=cm.challenge_id) entries
     FROM challenge_members cm JOIN users us ON us.id=cm.user_id WHERE cm.challenge_id=? ORDER BY cm.challenge_role='owner' DESC,us.name`).all(cid);
   const teams=isIndividual(c)?[]:db.prepare('SELECT id,name FROM teams WHERE challenge_id=? ORDER BY name').all(cid);
   return send(res,200,{members,teams});
 }
 // An owner or a global admin adds someone with an account, by email (global admins may also give user_id), as a
 // member or owner, optionally straight into a team. Owners get a generous hourly allowance.
 if(m==='POST'&&url.pathname.match(/^\/api\/challenges\/\d+\/members$/)){
   if(!need(res,u))return;
   const cid=Number(url.pathname.split('/')[3]),c=db.prepare('SELECT id,participation FROM challenges WHERE id=?').get(cid);
   if(!c)return send(res,404,{error:'Challenge not found'});
   if(!canManageChallenge(u,cid))return send(res,403,{error:'Only a challenge owner can add people'});
   if(!isAdmin(u)&&hitRateLimit('add:'+u.id,60,60*60_000))return send(res,429,{error:"That's a lot of people in an hour - share the invite link instead."});
   const b=await body(req),email=String(b.email||'').toLowerCase().trim();
   const who=isAdmin(u)&&b.user_id?db.prepare('SELECT id,name FROM users WHERE id=? AND deactivated_at IS NULL').get(Number(b.user_id)):email?db.prepare('SELECT id,name FROM users WHERE email=? AND deactivated_at IS NULL').get(email):null;
   if(!who)return send(res,404,{error:"No account uses that email. Share the challenge's invite link with them instead."});
   let teamId=null;
   if(b.team_id!==undefined&&b.team_id!==null&&b.team_id!==''){
     if(isIndividual(c))return send(res,400,{error:'This challenge is for individuals - it has no teams'});
     teamId=Number(b.team_id);
     if(!db.prepare('SELECT 1 FROM teams WHERE id=? AND challenge_id=?').get(teamId,cid))return send(res,400,{error:'That team is not part of this challenge'});
   }
   const added=addMember(cid,who.id,{role:b.role==='owner'?'owner':'member',teamId,by:u});
   return send(res,added?201:200,{ok:true,added,user:{id:who.id,name:who.name}});
 }
 // An owner (or global admin) removes someone - as leaving does, their entries in it go too. To leave
 // yourself, use leave.
 if(m==='DELETE'&&url.pathname.match(/^\/api\/challenges\/\d+\/members\/\d+$/)){
   if(!need(res,u))return;
   const parts=url.pathname.split('/'),cid=Number(parts[3]),targetId=Number(parts[5]);
   if(!canManageChallenge(u,cid))return send(res,403,{error:'Only a challenge owner can remove people'});
   if(targetId===u.id&&!isAdmin(u))return send(res,400,{error:'To leave the challenge yourself, use Leave challenge'});
   if(!challengeAccess(targetId,cid))return send(res,404,{error:'That person is not in this challenge'});
   const removed=removeFromChallenge(cid,targetId);
   audit(u,'removed from challenge',{user:targetId,challenge:cid,detail:`${removed} entries deleted`});
   return send(res,200,{ok:true,entriesDeleted:removed});
 }
 // One member's entries in a challenge, for its owners to check (and delete any that shouldn't count).
 if(m==='GET'&&url.pathname.match(/^\/api\/challenges\/\d+\/members\/\d+\/activities$/)){
   if(!need(res,u))return;
   const parts=url.pathname.split('/'),cid=Number(parts[3]),targetId=Number(parts[5]);
   if(!canManageChallenge(u,cid))return send(res,403,{error:'Only a challenge owner can view this'});
   const rows=db.prepare(`SELECT a.id,a.activity_type,a.minutes,a.distance_m,a.steps,a.activity_date,a.start_time,a.end_time,a.comment,a.source,t.name team_name,c.distance_unit
     FROM activities a LEFT JOIN teams t ON t.id=a.team_id JOIN challenges c ON c.id=a.challenge_id WHERE a.challenge_id=? AND a.user_id=? ORDER BY a.activity_date DESC,a.id DESC LIMIT 200`).all(cid,targetId);
   return send(res,200,{activities:rows.map(({distance_m,...a})=>({...a,distance:distance_m==null?null:metersToUnit(distance_m,a.distance_unit)}))});
 }
 if(m==='POST'&&url.pathname.match(/^\/api\/challenges\/\d+\/owners$/)){if(!need(res,u))return;const cid=Number(url.pathname.split('/')[3]);if(!db.prepare('SELECT id FROM challenges WHERE id=?').get(cid))return send(res,404,{error:'Challenge not found'});if(!canManageChallenge(u,cid))return send(res,403,{error:'Only a challenge owner can add another owner'});const b=await body(req),email=String(b.email||'').toLowerCase().trim();if(!email)return send(res,400,{error:'Email is required'});const found=db.prepare('SELECT id,name,email FROM users WHERE email=? AND deactivated_at IS NULL').get(email);
   // Owners and global admins may make anyone with an account an owner (adding them if they aren't in yet).
   if(!found)return send(res,404,{error:"No account uses that email. Share the challenge's invite link with them instead."});if(!isAdmin(u)&&hitRateLimit('add:'+u.id,60,60*60_000))return send(res,429,{error:"That's a lot of people in an hour - share the invite link instead."});addMember(cid,found.id,{role:'owner',by:u});return send(res,201,{ok:true,user:found})}
 if(m==='GET'&&url.pathname.match(/^\/api\/challenges\/\d+\/leaderboard\/export$/)){if(!need(res,u))return;const cid=Number(url.pathname.split('/')[3]),challenge=db.prepare('SELECT * FROM challenges WHERE id=?').get(cid);if(!challenge)return send(res,404,{error:'Challenge not found'});if(!canManageChallenge(u,cid))return send(res,403,{error:'Only the challenge owner or a global admin can export the leaderboard'});const type=url.searchParams.get('type')==='users'?'users':'teams';const lb=leaderboard(challenge),metric=challengeMetric(challenge),dist=metric==='distance',unitName=challengeUnit(challenge)==='km'?'Kilometres':'Miles';
   // A minutes challenge exports exactly as before; a distance challenge leads with distance and
   // keeps minutes alongside, since synced entries usually carry both.
   const valueCols=metric==='steps'?['Steps']:dist?[unitName,'Minutes']:['Minutes'],values=r=>metric==='steps'?[r.steps]:dist?[r.distance,r.minutes]:[r.minutes];let header,rows;if(type==='teams'){header=['Rank','Team',...valueCols];rows=lb.teams.map((r,i)=>[i+1,r.name,...values(r)])}else{header=['Rank','Name','Email',...valueCols];rows=lb.users.map((r,i)=>[i+1,r.name,r.email,...values(r)])}const csv=[header,...rows].map(r=>r.map(csvEscape).join(',')).join('\r\n'),safeName=challenge.name.replace(/[^a-z0-9]+/gi,'-').toLowerCase()||'challenge';res.writeHead(200,{'Content-Type':'text/csv; charset=utf-8','Content-Disposition':`attachment; filename="${safeName}-${type}.csv"`});return res.end(csv)}
 if(m==='GET'&&url.pathname.match(/^\/api\/challenges\/\d+\/leaderboard$/)){if(!need(res,u))return;const cid=Number(url.pathname.split('/')[3]);if(!challengeAccess(u.id,cid)&&!isAdmin(u))return send(res,403,{error:'You need an invite code to view this challenge'});const challenge=db.prepare('SELECT * FROM challenges WHERE id=?').get(cid);if(!challenge)return send(res,404,{error:'Challenge not found'});const lb=isJourney(challenge)?journeyStandings(challenge)||leaderboard(challenge):leaderboard(challenge),strip=({email,lat,lon,...r},i)=>({...r,rank:i+1});
   // ?top=N: the first N, plus my own row (and my teams) wherever they are, and how many there are in all.
   const top=Math.max(0,Number(url.searchParams.get('top'))||0),mineTeams=top?new Set(db.prepare('SELECT tm.team_id FROM team_members tm JOIN teams t ON t.id=tm.team_id WHERE tm.user_id=? AND t.challenge_id=?').all(u.id,cid).map(r=>r.team_id)):null;
   const cut=(rows,mine)=>{const all=rows.map(strip);return top?all.filter((r,i)=>i<top||mine(r)):all};
   // Where I stand: my place (level totals share one), who's just ahead and by how much, my last 7 days, my team's place.
   const metric=challengeMetric(challenge),val=r=>metric==='distance'?r.distance:metric==='steps'?r.steps:r.minutes;
   const place=(rows,i)=>rows.findIndex(r=>val(r)===val(rows[i]))+1;
   const mi=lb.users.findIndex(r=>r.id===u.id);let me=null;
   if(mi>=0){
     const mine=lb.users[mi],ahead=lb.users.slice(0,mi).reverse().find(r=>val(r)>val(mine));
     const wk=db.prepare("SELECT COALESCE(SUM(minutes),0) m,COALESCE(SUM(distance_m),0) d,COALESCE(SUM(steps),0) s FROM activities WHERE user_id=? AND challenge_id=? AND activity_date>=date('now','-6 days')").get(u.id,cid);
     const myTeam=!isIndividual(challenge)&&db.prepare('SELECT tm.team_id FROM team_members tm JOIN teams t ON t.id=tm.team_id WHERE tm.user_id=? AND t.challenge_id=? ORDER BY t.name LIMIT 1').get(u.id,cid);
     const ti=myTeam?lb.teams.findIndex(t=>t.id===myTeam.team_id):-1;
     me={rank:place(lb.users,mi),of:lb.users.length,total:val(mine),ahead:ahead?{name:ahead.name,gap:+(val(ahead)-val(mine)).toFixed(2)}:null,
       week:metric==='distance'?metersToUnit(wk.d,challengeUnit(challenge)):metric==='steps'?wk.s:wk.m,
       team:ti>=0?{name:lb.teams[ti].name,rank:place(lb.teams,ti),of:lb.teams.length}:null};
   }
   return send(res,200,{metric:challengeMetric(challenge),distance_unit:challengeUnit(challenge),participation:isIndividual(challenge)?'individual':'teams',journey:journeyInfo(challenge),
     teams:cut(lb.teams,r=>mineTeams&&mineTeams.has(r.id)),users:cut(lb.users,r=>r.id===u.id),teams_total:lb.teams.length,users_total:lb.users.length,me})}
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
   if(hitRateLimit('places:'+u.id,30,60_000))return send(res,429,{error:'Too many place searches - wait a minute and try again'});
   const q=String(url.searchParams.get('q')||'').trim().slice(0,120);
   if(q.length<2)return send(res,400,{error:'Type a place to search for'});
   try{
     const r=await geocoderFetch(`/search?format=jsonv2&limit=6&q=${encodeURIComponent(q)}`);
     return send(res,200,{places:r.map(x=>({name:x.name||String(x.display_name).split(',')[0],detail:x.display_name,lat:+x.lat,lon:+x.lon}))});
   }catch(e){return send(res,502,{error:e.message})}
 }
 if(m==='GET'&&url.pathname==='/api/places/reverse'){
   if(!need(res,u))return;
   if(hitRateLimit('places:'+u.id,30,60_000))return send(res,200,{name:null});
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
   if(hitRateLimit('routes:'+u.id,40,60_000))return send(res,429,{error:'Too many route previews - wait a minute and try again'});
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
   if(codeGuessBlocked(ip,u?.id))return send(res,429,CODE_BLOCKED);
   const team=code&&db.prepare('SELECT id,name,challenge_id,image_url,(SELECT COUNT(*) FROM team_members z WHERE z.team_id=teams.id) members FROM teams WHERE invite_code=?').get(code);
   const c=code&&db.prepare(`SELECT id,name,start_date,end_date,metric,distance_unit,participation,(SELECT COUNT(*) FROM challenge_members m WHERE m.challenge_id=challenges.id) members
     FROM challenges WHERE ${team?'id=?':'invite_code=?'}`).get(team?team.challenge_id:code);
   if(!c){noteBadCode(ip,u?.id);return send(res,404,{error:'That invite link has expired or the code was not recognised'})}
   const out={code,type:team?'team':'challenge',challenge:c,team:team?{id:team.id,name:team.name,image_url:team.image_url,members:team.members}:null};
   if(u){out.member=!!challengeAccess(u.id,c.id);out.inTeam=team?!!db.prepare('SELECT 1 FROM team_members WHERE team_id=? AND user_id=?').get(team.id,u.id):null}
   return send(res,200,out);
 }
 if(m==='POST'&&url.pathname==='/api/join'){if(!need(res,u))return;const b=await body(req),code=String(b.code||'').trim().toUpperCase();if(!code)return send(res,400,{error:'Invite code required'});if(codeGuessBlocked(ip,u.id))return send(res,429,CODE_BLOCKED);const j=joinWithCode(u.id,code);if(!j)noteBadCode(ip,u.id);return j?send(res,200,{ok:true,...j}):send(res,400,{error:'That invite code was not recognised'})}

 if(m==='POST'&&url.pathname==='/api/teams'){if(!need(res,u))return;const b=await body(req),cid=Number(b.challenge_id);if(!b.name||!cid)return send(res,400,{error:'challenge_id and name are required'});if(String(b.name).trim().length>MAX_LEN.team)return send(res,400,{error:tooLong(String(b.name).trim(),MAX_LEN.team,'the team name')});if(!challengeAccess(u.id,cid))return send(res,403,{error:'Join the challenge before creating a team in it'});if(isIndividual(db.prepare('SELECT participation FROM challenges WHERE id=?').get(cid)))return send(res,400,{error:'This challenge is for individuals - it has no teams'});let imageUrl;try{imageUrl=validateImageUrl(b.image_url)}catch(e){return send(res,400,{error:e.message})}const {id,invite_code}=insertTeam(cid,String(b.name).trim(),u.id,imageUrl||null);return send(res,201,{id,invite_code})}
 if(m==='POST'&&url.pathname.match(/^\/api\/teams\/\d+\/join$/)){if(!need(res,u))return;const tid=Number(url.pathname.split('/')[3]),team=db.prepare('SELECT * FROM teams WHERE id=?').get(tid);if(!team)return send(res,404,{error:'Team not found'});if(!challengeAccess(u.id,team.challenge_id))return send(res,403,{error:'Join the challenge before joining one of its teams'});db.prepare("INSERT OR IGNORE INTO team_members(team_id,user_id,team_role) VALUES(?,?,'member')").run(tid,u.id);return send(res,200,{ok:true})}
 if(m==='PATCH'&&url.pathname.match(/^\/api\/teams\/\d+$/)){if(!need(res,u))return;const tid=Number(url.pathname.split('/')[3]),team=db.prepare('SELECT * FROM teams WHERE id=?').get(tid);if(!team)return send(res,404,{error:'Team not found'});if(!canManageTeam(u,team))return send(res,403,{error:'Only a team admin or the challenge owner can rename this team'});const b=await body(req),name=String(b.name||'').trim();if(!name)return send(res,400,{error:'Name is required'});if(name.length>MAX_LEN.team)return send(res,400,{error:tooLong(name,MAX_LEN.team,'the team name')});let imageUrl;try{imageUrl=validateImageUrl(b.image_url)}catch(e){return send(res,400,{error:e.message})}if(imageUrl!==undefined)db.prepare('UPDATE teams SET name=?,image_url=? WHERE id=?').run(name,imageUrl,tid);else db.prepare('UPDATE teams SET name=? WHERE id=?').run(name,tid);return send(res,200,{ok:true})}
 if(m==='DELETE'&&url.pathname.match(/^\/api\/teams\/\d+$/)){if(!need(res,u))return;const tid=Number(url.pathname.split('/')[3]),team=db.prepare('SELECT * FROM teams WHERE id=?').get(tid);if(!team)return send(res,404,{error:'Team not found'});if(!canManageTeam(u,team))return send(res,403,{error:'Only a team admin or the challenge owner can delete this team'});try{db.exec('BEGIN');db.prepare('DELETE FROM activities WHERE team_id=?').run(tid);db.prepare('DELETE FROM teams WHERE id=?').run(tid);db.exec('COMMIT')}catch(e){db.exec('ROLLBACK');throw e}pruneRoutes();return send(res,200,{ok:true})}
 // Leave a team you're in. What you logged under it stays on its total, as when a team admin removes someone.
 if(m==='POST'&&url.pathname.match(/^\/api\/teams\/\d+\/leave$/)){
   if(!need(res,u))return;
   const tid=Number(url.pathname.split('/')[3]);
   if(!db.prepare('DELETE FROM team_members WHERE team_id=? AND user_id=?').run(tid,u.id).changes)return send(res,400,{error:"You're not in this team"});
   return send(res,200,{ok:true});
 }
 if(m==='GET'&&url.pathname.match(/^\/api\/teams\/\d+\/members$/)){if(!need(res,u))return;const tid=Number(url.pathname.split('/')[3]),team=db.prepare('SELECT * FROM teams WHERE id=?').get(tid);if(!team)return send(res,404,{error:'Team not found'});const manage=canManageTeam(u,team);if(!teamAccess(u.id,tid)&&!manage)return send(res,403,{error:'You need to be in this team to view its members'});// Email addresses only for whoever manages the team; teammates see names.
   const members=db.prepare('SELECT u.id,u.name,u.email,tm.team_role FROM team_members tm JOIN users u ON u.id=tm.user_id WHERE tm.team_id=? ORDER BY u.name').all(tid).map(x=>manage?x:{id:x.id,name:x.name,team_role:x.team_role});return send(res,200,{members,canManage:manage})}
 if(m==='POST'&&url.pathname.match(/^\/api\/teams\/\d+\/members$/)){if(!need(res,u))return;const tid=Number(url.pathname.split('/')[3]),team=db.prepare('SELECT * FROM teams WHERE id=?').get(tid);if(!team)return send(res,404,{error:'Team not found'});if(!canManageTeam(u,team))return send(res,403,{error:'Only a team admin or the challenge owner can add members'});const b=await body(req),email=String(b.email||'').toLowerCase().trim();if(!email)return send(res,400,{error:'Email is required'});const found=db.prepare('SELECT id,name,email FROM users WHERE email=? AND deactivated_at IS NULL').get(email);
   // Challenge owners and global admins can bring anyone with an account in; a team admin can only add people already in the challenge.
   const owner=canManageChallenge(u,team.challenge_id);
   if(!found||(!owner&&!challengeAccess(found.id,team.challenge_id)))return send(res,404,{error:owner?"No account uses that email. Share the team's invite link with them instead.":"Nobody in this challenge has that email. To bring someone new in, share the team's invite link."});
   if(owner&&!isAdmin(u)&&hitRateLimit('add:'+u.id,60,60*60_000))return send(res,429,{error:"That's a lot of people in an hour - share the invite link instead."});
   addMember(team.challenge_id,found.id,{teamId:tid,by:u});return send(res,201,{ok:true,user:found})}
 if(m==='DELETE'&&url.pathname.match(/^\/api\/teams\/\d+\/members\/\d+$/)){if(!need(res,u))return;const parts=url.pathname.split('/'),tid=Number(parts[3]),targetId=Number(parts[5]),team=db.prepare('SELECT * FROM teams WHERE id=?').get(tid);if(!team)return send(res,404,{error:'Team not found'});if(!canManageTeam(u,team))return send(res,403,{error:'Only a team admin or the challenge owner can remove members'});if(db.prepare('DELETE FROM team_members WHERE team_id=? AND user_id=?').run(tid,targetId).changes&&targetId!==u.id)audit(u,'removed from team',{user:targetId,challenge:team.challenge_id,detail:team.name});return send(res,200,{ok:true})}
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
   const activityType=String(b.activity_type||'').trim();
   if(!activityType)return send(res,400,{error:'Say what the activity was (walking, cycling...)'});
   if(activityType.length>MAX_LEN.activity)return send(res,400,{error:tooLong(activityType,MAX_LEN.activity,'the activity')});
   const rawTargets=Array.isArray(b.targets)&&b.targets.length?b.targets:[{challenge_id:b.challenge_id,team_id:b.team_id}];
   if(rawTargets.length>50)return send(res,400,{error:'Too many challenges at once'});
   const rows=[];
   for(const t of rawTargets){
     const challengeId=Number(t.challenge_id),challenge=db.prepare('SELECT * FROM challenges WHERE id=?').get(challengeId);
     const target=activityTarget(u,challenge,t.team_id);
     if(target.error)return send(res,target.status,{error:rawTargets.length>1&&challenge?`${challenge.name}: ${target.error}`:target.error});
     let times,minutes,distance_m,steps;
     try{requireInWindow(challenge,b.activity_date);times=validateTimes(b.start_time,b.end_time);minutes=parseMinutes(b.minutes)??null;distance_m=parseDistance(b,challengeUnit(challenge))??null;steps=parseSteps(b.steps)??null;requireMeasure(challenge,minutes,distance_m,steps,activityType)}
     catch(e){return send(res,400,{error:rawTargets.length>1?`${challenge.name}: ${e.message}`:e.message})}
     rows.push({challengeId,teamId:target.teamId,times,minutes,distance_m,steps});
   }
   let route;
   try{route=parseRoute(b.route)}catch(e){return send(res,400,{error:e.message})}
   const comment=b.comment!==undefined?(String(b.comment).trim().slice(0,500)||null):null;
   const source=b.source||'manual';
   if(!/^[a-z_]{1,30}$/.test(source))return send(res,400,{error:'source must be a short lower-case word'});
   const sourceRef=b.source_ref||(route?'gpx-'+crypto.randomUUID():null);
   try{
     db.exec('BEGIN');
     const routeId=route?saveRoute(u.id,source,sourceRef,route):null;
     const ins=db.prepare('INSERT INTO activities(user_id,team_id,challenge_id,activity_type,minutes,distance_m,steps,activity_date,source,source_ref,start_time,end_time,comment,route_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
     for(const r of rows)ins.run(u.id,r.teamId,r.challengeId,activityType,r.minutes,r.distance_m,r.steps,b.activity_date,source,sourceRef,r.times.start_time,r.times.end_time,comment,routeId);
     db.exec('COMMIT');
   }catch(e){db.exec('ROLLBACK');return send(res,400,{error:'Invalid or duplicate activity'})}
   return send(res,201,{ok:true,created:rows.length});
 }
 // Everything this user has logged, newest first, across every challenge - the companion's
 // "My activity" list. Paged; has_route says whether a map can be shown.
 if(m==='GET'&&url.pathname==='/api/me/activities'){
   if(!need(res,u))return;
   const limit=Math.min(Math.max(Number(url.searchParams.get('limit'))||50,1),200),offset=Math.max(Number(url.searchParams.get('offset'))||0,0);
   const cid=Number(url.searchParams.get('challenge_id'))||null;
   const rows=db.prepare(`SELECT a.id,a.challenge_id,a.team_id,a.activity_type,a.minutes,a.distance_m,a.steps,a.activity_date,a.start_time,a.end_time,a.comment,a.source,a.source_ref,a.route_id,t.name team_name,c.name challenge_name,c.metric,c.distance_unit FROM activities a LEFT JOIN teams t ON t.id=a.team_id JOIN challenges c ON c.id=a.challenge_id WHERE a.user_id=?${cid?' AND a.challenge_id=?':''} ORDER BY a.activity_date DESC,a.start_time DESC,a.id DESC LIMIT ? OFFSET ?`).all(...(cid?[u.id,cid]:[u.id]),limit+1,offset);
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
   if(activity_type.length>MAX_LEN.activity)return send(res,400,{error:tooLong(activity_type,MAX_LEN.activity,'the activity')});
   let times;
   try{if(b.activity_date!==undefined)requireInWindow(challenge,activity_date);times=validateTimes(start_time,end_time);requireMeasure(challenge,minutes,distance_m,steps,activity_type)}catch(e){return send(res,400,{error:e.message})}
   db.prepare('UPDATE activities SET activity_type=?,minutes=?,distance_m=?,steps=?,activity_date=?,start_time=?,end_time=?,comment=? WHERE id=?').run(activity_type,minutes,distance_m,steps,activity_date,times.start_time,times.end_time,comment,id);
   return send(res,200,{ok:true});
 }
 if(m==='DELETE'&&url.pathname.match(/^\/api\/activities\/\d+$/)){
   if(!need(res,u))return;
   const id=Number(url.pathname.split('/')[3]),existing=db.prepare('SELECT * FROM activities WHERE id=?').get(id);
   if(!existing)return send(res,404,{error:'Activity not found'});
   if(existing.user_id!==u.id&&!canManageChallenge(u,existing.challenge_id))return send(res,403,{error:'You can only delete your own activity'});
   db.prepare('DELETE FROM activities WHERE id=?').run(id);
   if(existing.user_id!==u.id)audit(u,'deleted an entry',{user:existing.user_id,challenge:existing.challenge_id,detail:`${existing.activity_type} on ${existing.activity_date}`});
   pruneRoutes([existing.route_id]);
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
   ticketMail(Number(r.lastInsertRowid),false,`new ${type==='bug'?'bug report':type==='feature'?'feature request':'question'} from ${u.name}`);
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
 // Global admins: every open ticket (new, in progress, planned) as plain text with its conversation, to copy
 // somewhere in one go. Reading it doesn't mark anything seen.
 if(m==='GET'&&url.pathname==='/api/admin/tickets/open-text'){
   if(!need(res,u,['global_admin']))return;
   const rows=db.prepare(`${TICKET_SELECT} WHERE t.status IN ('new','in_progress','planned') ORDER BY t.id`).all();
   const label={bug:'Bug',feature:'Feature request',question:'Question'},state={new:'New',in_progress:'In progress',planned:'Planned'};
   const text=rows.map(t=>{
     const replies=db.prepare('SELECT c.body,c.internal,c.created_at,c.user_id,us.name FROM ticket_comments c JOIN users us ON us.id=c.user_id WHERE c.ticket_id=? ORDER BY c.id').all(t.id);
     return [`#${t.id} · ${label[t.type]||t.type} · ${state[t.status]||t.status} · ${t.reporter_name} (${t.reporter_email}) · ${String(t.created_at).slice(0,16)} UTC`,
       `Title: ${t.title}`,t.description,t.client_info&&`Device: ${t.client_info}`,t.image_url&&`Screenshot: ${ORIGIN}${t.image_url}`,
       replies.length&&'Replies:\n'+replies.map(r=>`- ${r.name}${r.internal?' (internal note)':r.user_id===t.user_id?' (reporter)':' (support)'}, ${String(r.created_at).slice(0,16)}: ${r.body}`).join('\n'),
       t.resolution&&`Outcome so far: ${t.resolution}`].filter(Boolean).join('\n');
   }).join('\n\n---\n\n');
   return send(res,200,{count:rows.length,text});
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
   else if(t.user_id===u.id){db.prepare('UPDATE tickets SET updated_at=?,last_user_reply_at=?,owner_seen_at=? WHERE id=?').run(at,at,at,id);ticketMail(id,false,`${u.name} replied`)}
   else{db.prepare('UPDATE tickets SET updated_at=?,last_reply_at=?,admin_seen_at=? WHERE id=?').run(at,at,at,id);ticketMail(id,true,'support replied')}
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
   if(t.user_id!==u.id)ticketMail(id,true,status!==t.status?`it's now ${({new:'new',in_progress:'in progress',planned:'planned',done:'done',declined:'declined'})[status]}`:'the outcome was updated');
   return send(res,200,{ok:true});
 }
 // Global admins: every user, with how involved they are.
 // ?q= searches names and emails; ?limit= and ?offset= page through (no limit: everyone, as the apps expect).
 if(m==='GET'&&url.pathname==='/api/admin/users'){
   if(!need(res,u,['global_admin']))return;
   const q=String(url.searchParams.get('q')||'').trim().toLowerCase(),limit=Number(url.searchParams.get('limit'))||0,offset=Math.max(0,Number(url.searchParams.get('offset'))||0);
   const where=q?" WHERE lower(us.name) LIKE ? ESCAPE '\\' OR us.email LIKE ? ESCAPE '\\'":'',like='%'+q.replace(/[\\%_]/g,c=>'\\'+c)+'%',args=q?[like,like]:[];
   const users=db.prepare(`SELECT us.id,us.email,us.name,us.role,us.created_at,us.avatar_url,us.deactivated_at,(us.totp_secret IS NOT NULL) two_factor,
     (SELECT COUNT(*) FROM challenge_members cm WHERE cm.user_id=us.id) challenges,
     (SELECT COUNT(*) FROM activities a WHERE a.user_id=us.id) activities,
     (SELECT MAX(a.activity_date) FROM activities a WHERE a.user_id=us.id) last_activity,
     (SELECT COUNT(*) FROM tickets t WHERE t.user_id=us.id) tickets
     FROM users us${where} ORDER BY us.name${limit?' LIMIT ? OFFSET ?':''}`).all(...args,...(limit?[Math.min(limit,200),offset]:[]));
   return send(res,200,{users,total:db.prepare(`SELECT COUNT(*) n FROM users us${where}`).get(...args).n});
 }
 // Global admins: the audit log, newest first, searchable by what was done or who.
 if(m==='GET'&&url.pathname==='/api/admin/audit'){
   if(!need(res,u,['global_admin']))return;
   const q=String(url.searchParams.get('q')||'').trim().toLowerCase(),limit=Math.min(Number(url.searchParams.get('limit'))||100,500),offset=Math.max(0,Number(url.searchParams.get('offset'))||0);
   const like='%'+q.replace(/[\\%_]/g,c=>'\\'+c)+'%';
   const rows=db.prepare(`SELECT l.id,l.at,l.action,l.detail,l.challenge_id,a.name actor_name,a.id actor_id,t.name target_name,t.id target_id,c.name challenge_name FROM audit_log l
     LEFT JOIN users a ON a.id=l.actor_id LEFT JOIN users t ON t.id=l.target_user_id LEFT JOIN challenges c ON c.id=l.challenge_id
     ${q?"WHERE lower(l.action) LIKE ? ESCAPE '\\' OR lower(coalesce(a.name,'')) LIKE ? ESCAPE '\\' OR lower(coalesce(t.name,'')) LIKE ? ESCAPE '\\' OR lower(coalesce(c.name,'')) LIKE ? ESCAPE '\\'":''}
     ORDER BY l.id DESC LIMIT ? OFFSET ?`).all(...(q?[like,like,like,like]:[]),limit+1,offset);
   return send(res,200,{entries:rows.slice(0,limit),more:rows.length>limit});
 }
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
 // Global admins: who is in a challenge, and adding or removing anyone. Removal is what leaving does
 // (their entries in it go too, so team totals and the individual board stay in step), and may take
 // out the last owner - global admins can still manage an ownerless challenge.
 if(url.pathname.match(/^\/api\/admin\/challenges\/\d+\/members(\/\d+)?$/)){
   if(!need(res,u,['global_admin']))return;
   const parts=url.pathname.split('/'),cid=Number(parts[4]),targetId=parts[6]?Number(parts[6]):null;
   const c=db.prepare('SELECT id,participation FROM challenges WHERE id=?').get(cid);
   if(!c)return send(res,404,{error:'Challenge not found'});
   if(m==='GET'&&!targetId){
     const members=db.prepare(`SELECT us.id,us.name,us.email,us.avatar_url,us.deactivated_at,cm.challenge_role role,cm.joined_at,
       (SELECT group_concat(t.name,', ') FROM teams t JOIN team_members tm ON tm.team_id=t.id WHERE tm.user_id=us.id AND t.challenge_id=cm.challenge_id) teams,
       (SELECT COUNT(*) FROM activities a WHERE a.user_id=us.id AND a.challenge_id=cm.challenge_id) entries
       FROM challenge_members cm JOIN users us ON us.id=cm.user_id WHERE cm.challenge_id=? ORDER BY cm.challenge_role='owner' DESC,us.name`).all(cid);
     const teams=isIndividual(c)?[]:db.prepare('SELECT id,name FROM teams WHERE challenge_id=? ORDER BY name').all(cid);
     return send(res,200,{members,teams});
   }
   if(m==='POST'&&!targetId){
     const b=await body(req),uid=Number(b.user_id),role=b.role==='owner'?'owner':'member';
     if(!db.prepare('SELECT 1 FROM users WHERE id=? AND deactivated_at IS NULL').get(uid))return send(res,404,{error:'User not found'});
     let teamId=null;
     if(b.team_id!==undefined&&b.team_id!==null&&b.team_id!==''){
       if(isIndividual(c))return send(res,400,{error:'This challenge is for individuals - it has no teams'});
       teamId=Number(b.team_id);
       if(!db.prepare('SELECT 1 FROM teams WHERE id=? AND challenge_id=?').get(teamId,cid))return send(res,400,{error:'That team is not part of this challenge'});
     }
     const added=addMember(cid,uid,{role,teamId,by:u});
     return send(res,added?201:200,{ok:true,added});
   }
   if(m==='DELETE'&&targetId){
     if(!challengeAccess(targetId,cid))return send(res,404,{error:'That person is not in this challenge'});
     const removed=removeFromChallenge(cid,targetId);
     audit(u,'removed from challenge',{user:targetId,challenge:cid,detail:`${removed} entries deleted`});
     return send(res,200,{ok:true,entriesDeleted:removed});
   }
   return send(res,405,{error:'Method not allowed'});
 }
 if(m==='POST'&&url.pathname.match(/^\/api\/admin\/users\/\d+\/reset-link$/)){
   if(!need(res,u,['global_admin']))return;
   const id=Number(url.pathname.split('/')[4]);
   if(!db.prepare('SELECT 1 FROM users WHERE id=?').get(id))return send(res,404,{error:'User not found'});
   audit(u,'made a password reset link',{user:id});
   return send(res,201,makeResetLink(id,24*60,u.id));
 }
 if(m==='POST'&&url.pathname==='/api/admin/users'){if(!need(res,u,['global_admin']))return;const b=await body(req);if(!String(b.name||'').trim()||!String(b.email||'').trim()||String(b.password||'').length<8||!['member','global_admin',undefined,''].includes(b.role))return send(res,400,{error:'Name, email, a password of at least 8 characters and a valid role are required'});const nm=String(b.name).trim(),em=String(b.email).toLowerCase().trim(),fieldErr=tooLong(nm,MAX_LEN.person,'the name')||(!validEmail(em)&&'Enter a valid email address')||passwordProblem(b.password,{email:em,name:nm});if(fieldErr)return send(res,400,{error:fieldErr});try{const r=db.prepare('INSERT INTO users(email,name,password_hash,role) VALUES(?,?,?,?)').run(em,nm,await hash(b.password),b.role||'member');audit(u,'created account',{user:Number(r.lastInsertRowid),detail:b.role==='global_admin'?'global admin':null});sendEmailCheck(Number(r.lastInsertRowid),em);return send(res,201,{id:Number(r.lastInsertRowid)})}catch(e){return send(res,400,{error:'Email already exists or fields are invalid'})}}
 if(m==='PATCH'&&url.pathname.match(/^\/api\/admin\/users\/\d+$/)){
   if(!need(res,u,['global_admin']))return;
   const id=Number(url.pathname.split('/').pop()),b=await body(req),target=db.prepare('SELECT id,name,email,role,deactivated_at,totp_secret FROM users WHERE id=?').get(id);
   if(!target)return send(res,404,{error:'User not found'});
   const deactivating=b.active===false&&!target.deactivated_at,demoting=b.role!==undefined&&b.role!=='global_admin';
   if(deactivating||(demoting&&target.role==='global_admin')){const err=adminUserChangeError(u,target,{removesAdmin:true});if(err)return send(res,400,{error:err})}
   if(b.role!==undefined&&!['member','global_admin'].includes(b.role))return send(res,400,{error:'Unknown role'});
   const name=b.name!==undefined?String(b.name).trim():undefined;
   if(name!==undefined&&!name)return send(res,400,{error:'Name cannot be empty'});
   if(name!==undefined&&name.length>MAX_LEN.person)return send(res,400,{error:tooLong(name,MAX_LEN.person,'the name')});
   const email=b.email!==undefined?String(b.email).toLowerCase().trim():undefined;
   if(email!==undefined&&!email)return send(res,400,{error:'Email cannot be empty'});
   if(email!==undefined&&email!==target.email&&!validEmail(email))return send(res,400,{error:'Enter a valid email address'});
   let passwordHash;
   if(b.password){const pwErr=passwordProblem(b.password,{email:email||target.email,name:name||target.name});if(pwErr)return send(res,400,{error:pwErr});passwordHash=await hash(b.password)}
   try{
     updateUserFields(id,{name,email,passwordHash});
     if(b.role!==undefined)db.prepare('UPDATE users SET role=? WHERE id=?').run(b.role,id);
   }catch(e){if(isUniqueViolation(e))return send(res,409,{error:'An account with that email already exists'});throw e}
   if(b.active!==undefined)db.prepare('UPDATE users SET deactivated_at=? WHERE id=?').run(b.active?null:(target.deactivated_at||nowIso()),id);
   // An admin can switch off someone's two-step sign-in (a lost phone, no backup codes).
   const clear2fa=b.twoFactor===false&&target.totp_secret;
   if(clear2fa){db.prepare('UPDATE users SET totp_secret=NULL,totp_pending=NULL,totp_last_step=NULL WHERE id=?').run(id);db.prepare('DELETE FROM totp_backup_codes WHERE user_id=?').run(id)}
   // A new password or deactivation ends every session that account has open.
   if(passwordHash||deactivating)db.prepare('DELETE FROM sessions WHERE user_id=?').run(id);
   // An address an admin typed hasn't been confirmed by its owner.
   if(email!==undefined&&email!==target.email){db.prepare('UPDATE users SET email_verified_at=NULL,pending_email=NULL WHERE id=?').run(id);sendEmailCheck(id,email)}
   if(passwordHash)securityMail(id,'An administrator set a new password');
   if(clear2fa)securityMail(id,'An administrator turned off two-step sign-in');
   const changes=[name!==undefined&&name!==target.name&&'name',email!==undefined&&email!==target.email&&'email',passwordHash&&'password',
     b.role!==undefined&&b.role!==target.role&&`role: ${b.role==='global_admin'?'global admin':'member'}`,deactivating&&'deactivated',b.active===true&&target.deactivated_at&&'reactivated',clear2fa&&'two-step sign-in off'].filter(Boolean);
   if(changes.length)audit(u,'changed account',{user:id,detail:changes.join(', ')});
   return send(res,200,{ok:true})
 }
 // Delete my own account, confirmed with my password - both app stores require this in the app. The
 // same clean-up as an admin deletion; a challenge I own alone passes to its longest-standing member,
 // or is deleted with me if nobody else is in it.
 if((m==='DELETE'&&url.pathname==='/api/me')||(m==='POST'&&url.pathname==='/api/me/delete')){
   if(!need(res,u))return;
   const b=await body(req),row=db.prepare('SELECT password_hash FROM users WHERE id=?').get(u.id);
   if(hasPassword(row.password_hash)?!b.password||!(await verify(String(b.password),row.password_hash)):String(b.password||b.confirm||'').trim().toUpperCase()!=='DELETE')
     return send(res,400,{error:hasPassword(row.password_hash)?'Enter your current password to delete your account':'You sign in with Google or Apple, so type DELETE to confirm'});
   if(u.email===seedEmail)return send(res,400,{error:"This is the site's built-in admin account from the server settings - it can't be deleted."});
   const heir=db.prepare("SELECT id FROM users WHERE role='global_admin' AND deactivated_at IS NULL AND id!=? ORDER BY id LIMIT 1").get(u.id);
   if(!heir)return send(res,400,{error:"You're the only global admin - make someone else an admin first"});
   deleteAccount(u.id,heir.id);
   audit(null,'deleted own account',{detail:`user ${u.id}`});
   return send(res,200,{ok:true},clearSessionCookie);
 }
 if(m==='DELETE'&&url.pathname.match(/^\/api\/admin\/users\/\d+$/)){
   if(!need(res,u,['global_admin']))return;
   const id=Number(url.pathname.split('/').pop()),target=db.prepare('SELECT id,email,role,deactivated_at FROM users WHERE id=?').get(id);
   if(!target)return send(res,404,{error:'User not found'});
   const err=adminUserChangeError(u,target,{removesAdmin:true});if(err)return send(res,400,{error:err});
   if(target.email===seedEmail)return send(res,400,{error:'This is the built-in admin account from the server settings - it would be re-created on restart. Deactivate it instead.'});
   // Gone for good, as deleting your own account works; what they created is credited to the admin doing it.
   const gone=db.prepare('SELECT name,email FROM users WHERE id=?').get(id);
   deleteAccount(id,u.id);
   audit(u,'deleted account',{detail:`${gone.name} <${gone.email}>`});
   return send(res,200,{ok:true});
 }

 if(m==='GET'&&url.pathname==='/api/health/status'){if(!need(res,u))return;return send(res,200,{healthConnect:{platform:'Android',mode:'native-companion-required'},healthKit:{platform:'iOS',mode:'native-companion-required'},acceptedRecord:'exercise session duration and distance',uploadEndpoint:'/api/health/import'})}
 // My Apple Shortcuts key: whether I have one, a new one (shown once, replacing any old one), or none.
 if(url.pathname==='/api/me/sync-key'&&['GET','POST','DELETE'].includes(m)){
   if(!need(res,u))return;
   if(m==='POST'){
     const key='at_'+crypto.randomBytes(20).toString('hex');
     db.prepare('INSERT INTO sync_keys(user_id,key_hash) VALUES(?,?)').run(u.id,sha256hex(key));
     db.prepare('DELETE FROM sync_keys WHERE user_id=? AND id NOT IN (SELECT id FROM sync_keys WHERE user_id=? ORDER BY id DESC LIMIT ?)').run(u.id,u.id,SYNC_KEYS_KEPT);
     return send(res,201,{key});
   }
   if(m==='DELETE'){db.prepare('DELETE FROM sync_keys WHERE user_id=?').run(u.id);return send(res,200,{ok:true})}
   const r=db.prepare('SELECT COUNT(*) n,MAX(created_at) newest FROM sync_keys WHERE user_id=?').get(u.id);
   return send(res,200,{exists:r.n>0,count:r.n,created_at:r.newest});
 }
 // One day's totals from the Apple Shortcut: steps, exercise minutes, walking and running distance and
 // cycling distance, in one request or one per figure. Each figure is kept in shortcut_days, so one
 // not sent keeps its last value. The day's entry in every challenge I'm in that runs that day is
 // then worked out from them: a step challenge takes the steps, a minutes challenge the minutes, a
 // distance challenge walking plus cycling, an on-foot journey walking only, and a cycling journey
 // cycling only - under my first team in a team challenge. Sending a day again replaces it; an entry
 // left with nothing to count is removed.
 if(m==='POST'&&url.pathname==='/api/shortcut/day'){
   // JSON as the guide says, or a form if the shortcut's Request Body was left on Form.
   let b,raw;
   try{raw=await bodyText(req);b=raw.trim().startsWith('{')?JSON.parse(raw):Object.fromEntries(new URLSearchParams(raw))}catch(e){b=null}
   const key=String(req.headers['x-sync-key']||b?.key||'').trim();
   const owner=key&&db.prepare('SELECT u.id,u.name FROM sync_keys k JOIN users u ON u.id=k.user_id WHERE k.key_hash=? AND u.deactivated_at IS NULL').get(sha256hex(key));
   if(!owner){
     console.log(`Shortcut sync: key not recognised (${key?`${key.length} characters, starting ${key.slice(0,3)}`:'no key sent'}; ${req.headers['x-sync-key']?'in the header':'in the body'}; fields: ${b?Object.keys(b).map(k=>JSON.stringify(k)).join(', ')||'none':'body unreadable'}; ${req.headers['content-type']||'no content type'})`);
     return send(res,401,{error:'That sync key is not recognised. Make a new one with Set up Apple Shortcuts on the activetogether.team home page.'});
   }
   // A rejected day is logged (field names and values, never the key) and the reply says what arrived,
   // so a mistake in someone's shortcut can be found.
   const reject=error=>{
     const seen=b?Object.entries(b).filter(([k])=>k!=='key').map(([k,v])=>`${k}=${JSON.stringify(v)}`.slice(0,80)).join(' '):`unreadable body ${JSON.stringify(String(raw||'').slice(0,80))}`;
     console.log(`Shortcut sync rejected for user ${owner.id}: ${error} | ${req.headers['content-type']||'no content type'} | ${seen}`);
     return send(res,400,{error});
   };
   if(!b)return reject('The shortcut must send JSON: in Get Contents of URL, set Request Body to JSON');
   const date=shortcutDate(b.date);
   if(!date)return reject(`date must look like 2026-10-07 (got ${JSON.stringify(b.date??null)}). In Format Date, choose Custom and type yyyy-MM-dd`);
   if(date>new Date(Date.now()+864e5).toISOString().slice(0,10))return reject(`That date (${date}) is in the future`);
   // Shortcuts may send numbers as text, with thousands separators, decimals or a unit ("8,412 steps"),
   // and distances in whatever unit the Health app uses. undefined = not sent this time.
   const num=v=>{if(v===undefined)return undefined;if(typeof v==='number')return v>0?v:0;const m=String(v??'').replace(/,/g,'').match(/\d+(\.\d+)?/);return m&&Number(m[0])>0?Number(m[0]):0};
   const perUnit=v=>{const t=String(v||'mi').trim().toLowerCase();return /^(km|kilomet(er|re)s?)$/.test(t)?1000:/^(m|met(er|re)s?)$/.test(t)?1:/^(mi|miles?)$/.test(t)?METERS_PER.mi:null};
   const walkPer=perUnit(b.distance_unit),cyclePer=perUnit(b.cycling_unit||b.distance_unit);
   if(walkPer===null||cyclePer===null)return reject(`distance units must be mi, km or m (got ${JSON.stringify(b.distance_unit??b.cycling_unit)})`);
   const sent={steps:num(b.steps)===undefined?undefined:Math.round(num(b.steps)),minutes:num(b.minutes)===undefined?undefined:Math.round(num(b.minutes)),
     walk_m:num(b.distance)===undefined?undefined:num(b.distance)*walkPer,cycle_m:num(b.cycling_distance)===undefined?undefined:num(b.cycling_distance)*cyclePer};
   if(Object.values(sent).every(v=>v===undefined))return reject(`Nothing to save: send steps, minutes, distance or cycling_distance (got ${Object.keys(b).filter(k=>k!=='key').join(', ')||'no fields'})`);
   if(sent.steps>200000)return reject(`That is more steps than anyone walks in a day (got ${sent.steps}) - check the shortcut`);
   // One line per accepted day too (fields and values, never the key), to help when setting up a shortcut.
   console.log(`Shortcut sync for user ${owner.id}: ${Object.entries(b).filter(([k])=>k!=='key').map(([k,v])=>`${k}=${JSON.stringify(v)}`.slice(0,60)).join(' ')}`);
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
   let added=0,skipped=0,updated=0;const savedRoutes=[];
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
       if(route)savedRoutes.push(routeId);
       db.prepare('INSERT INTO activities(user_id,team_id,challenge_id,activity_type,minutes,distance_m,steps,activity_date,source,source_ref,start_time,end_time,route_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(u.id,teamId,challengeId,String(x.activity_type||'Synced activity').trim().slice(0,60)||'Synced activity',minutes,distance_m,steps,x.activity_date,b.source,x.source_ref,times.start_time,times.end_time,routeId);added++
     }catch(e){skipped++}
   }
   // A route saved for a record that then wasn't added (a duplicate) has nothing using it.
   pruneRoutes(savedRoutes);
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
// Map pictures (the website's maps and the Android app's): OpenStreetMap's own tiles unless TILE_URL names a provider
// ({z}/{x}/{y}, and {s} for its subdomains, as Leaflet takes them), whose key is then part of the address.
const TILE_URL=process.env.TILE_URL||'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const TILE_ATTRIBUTION=process.env.TILE_ATTRIBUTION||'&copy; OpenStreetMap contributors';
const TILE_MAX_ZOOM=Number(process.env.TILE_MAX_ZOOM||19);
const TILE_ORIGIN=(()=>{try{const sub=TILE_URL.includes('{s}'),o=new URL(TILE_URL.replace('{s}','a').replace(/\{[a-z]+\}/gi,'0')).origin;return sub?o.replace('://a.','://*.'):o}catch(e){return 'https://tile.openstreetmap.org'}})();
// Sent with every response. Scripts only from this site (plus the bot check: Cloudflare Turnstile, or Google's
// reCAPTCHA); no framing by other sites; images only from this site and the OpenStreetMap tiles.
const SECURITY_HEADERS={
  'Content-Security-Policy':["default-src 'self'","script-src 'self' https://challenges.cloudflare.com https://www.google.com/recaptcha/ https://www.gstatic.com/recaptcha/ https://accounts.google.com/gsi/client https://appleid.cdn-apple.com",
    "style-src 'self' 'unsafe-inline' https://accounts.google.com/gsi/style",`img-src 'self' data: blob: ${TILE_ORIGIN}`,"connect-src 'self' https://accounts.google.com/gsi/","font-src 'self' data:",
    "frame-src https://challenges.cloudflare.com https://www.google.com/recaptcha/ https://recaptcha.google.com/recaptcha/ https://accounts.google.com/gsi/ https://appleid.apple.com","object-src 'none'","base-uri 'self'","form-action 'self'","frame-ancestors 'none'"].join('; '),
  'X-Frame-Options':'DENY','X-Content-Type-Options':'nosniff','Referrer-Policy':'strict-origin-when-cross-origin',
  'Permissions-Policy':'camera=(), microphone=(), geolocation=(), payment=()',
  ...(ORIGIN.startsWith('https:')?{'Strict-Transport-Security':'max-age=31536000'}:{}),
};
const STATIC_TYPES={'.json':'application/json','.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'application/javascript; charset=utf-8','.svg':'image/svg+xml','.ico':'image/x-icon','.png':'image/png','.txt':'text/plain; charset=utf-8'};
// Pages link the site's own script and stylesheet with ?v=<content hash>, so a deploy is picked up at once
// even where a cache (Cloudflare's browser TTL) holds files for hours; the versioned files can then be cached
// for good.
const VERSIONED=['app.js','style.css','theme.js'];
const ASSET_V=crypto.createHash('sha256').update(VERSIONED.map(f=>{try{return fs.readFileSync(path.join(__dirname,'public',f))}catch(e){return ''}}).join('|')).digest('hex').slice(0,10);
const attr=v=>String(v).replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
// Link previews (WhatsApp, Messages, Slack...): absolute image addresses, and an invite link names what it's for.
const absolutePreview=html=>html.replace(/content="\/icon-512\.png"/g,`content="${ORIGIN}/icon-512.png"`).replace('content="summary_large_image"','content="summary"');
function previewTags(html,pathname,ip){
  const m=pathname.match(/^\/join\/([A-Za-z0-9]+)\/?$/);
  if(!m||codeGuessBlocked(ip))return html;
  const code=m[1].toUpperCase(),team=db.prepare('SELECT name,challenge_id FROM teams WHERE invite_code=?').get(code);
  const c=db.prepare(`SELECT name,start_date,end_date FROM challenges WHERE ${team?'id=?':'invite_code=?'}`).get(team?team.challenge_id:code);
  if(!c){noteBadCode(ip);return html}
  const title=team?`Join ${team.name} in ${c.name}`:`Join ${c.name}`;
  const desc=`You're invited to ${team?`the team ${team.name} in `:''}${c.name}, an activity challenge on Active Together (${c.start_date} to ${c.end_date}).`;
  return html.replace(/<meta property="og:title" content="[^"]*">/,`<meta property="og:title" content="${attr(title)}"><meta property="og:url" content="${attr(ORIGIN+'/join/'+code)}">`)
    .replace(/<meta property="og:description" content="[^"]*">/,`<meta property="og:description" content="${attr(desc)}">`)
    .replace(/<title>[^<]*<\/title>/,`<title>${attr(title)} - Active Together</title>`);
}
const versionAssets=html=>html.replace(/(src|href)="(\/?)(app\.js|style\.css|theme\.js)"/g,`$1="$2$3?v=${ASSET_V}"`);
// Pages with their asset versions and preview addresses filled in, kept in memory: they only change with a deploy.
const pageCache=new Map();
function pageHtml(f,st){
  const key=`${f}:${st.mtimeMs}:${st.size}`;let h=pageCache.get(key);
  if(h===undefined){h=absolutePreview(versionAssets(fs.readFileSync(f,'utf8')));remember(pageCache,key,h,30)}
  return h;
}
const server=http.createServer(async(req,res)=>{try{for(const [k,v] of Object.entries(SECURITY_HEADERS))res.setHeader(k,v);const url=new URL(req.url,ORIGIN);if(url.pathname.startsWith('/api/'))return await api(req,res,url);
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
 // Browsers keep a copy but check it each time (unchanged files come back as a small 304); a versioned
 // script or stylesheet (?v=) never changes, so it's kept for a year.
 const ext=path.extname(f),st=fs.statSync(f),html=ext==='.html';
 const etag=`"${st.size.toString(36)}-${Math.floor(st.mtimeMs).toString(36)}${html?'-'+ASSET_V:''}"`;
 const forever=url.searchParams.has('v')&&VERSIONED.includes(path.basename(f));
 // An invite page's preview depends on the challenge, so it isn't tagged for reuse.
 const invitePage=html&&/^\/join\//.test(url.pathname);
 const headers={'Content-Type':STATIC_TYPES[ext]||'application/octet-stream','Cache-Control':forever?'public, max-age=31536000, immutable':'no-cache',...(invitePage?{}:{'ETag':etag})};
 // A proxy that compresses may weaken the tag to W/"..."; it still names the same file.
 if(!invitePage&&String(req.headers['if-none-match']||'').split(',').some(t=>t.trim().replace(/^W\//,'')===etag)){res.writeHead(304,headers);return res.end()}
 res.writeHead(200,headers);
 if(html)return res.end(invitePage?previewTags(pageHtml(f,st),url.pathname,clientIp(req)):pageHtml(f,st));
 fs.createReadStream(f).pipe(res)}catch(e){if(e.status){if(!res.headersSent)send(res,e.status,{error:e.message});return}console.error(e);if(!res.headersSent)send(res,500,{error:'Server error'})}});// Node's default keepAliveTimeout is 5s, which races a client that reuses a pooled keep-alive
// connection right as the server decides to close it - the client's write lands on a socket the
// server is already tearing down, seen as a bare ECONNRESET with no HTTP response at all.
// headersTimeout must exceed keepAliveTimeout or Node logs a warning and clamps it back down.
server.keepAliveTimeout=65_000;
server.headersTimeout=66_000;
server.listen(PORT,()=>console.log(`Activity Challenge running on ${ORIGIN}`));
// Stopping (a deploy, a switch-over): take no new connections, let requests in progress finish (up to 10
// seconds), then close the database cleanly.
let stopping=false;
function shutdown(sig){
  if(stopping)return;stopping=true;
  console.log(`${sig}: finishing requests in progress, then stopping`);
  server.close(()=>{try{db.close()}catch(e){}process.exit(0)});
  server.closeIdleConnections();
  setTimeout(()=>{server.closeAllConnections();try{db.close()}catch(e){}process.exit(0)},10_000).unref();
}
process.on('SIGTERM',()=>shutdown('SIGTERM'));
process.on('SIGINT',()=>shutdown('SIGINT'));
