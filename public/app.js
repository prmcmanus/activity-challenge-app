const $=s=>document.querySelector(s), $all=s=>[...document.querySelectorAll(s)];
const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const api=async(url,opt={})=>{const r=await fetch(url,{headers:{'Content-Type':'application/json'},...opt});const j=await r.json().catch(()=>({}));if(!r.ok)throw Error(j.error||'Request failed');return j};

let me=null, dash=null, curChallenge=null, curLeaderboard=null, authTab='login';
const params=new URLSearchParams(location.search);
let pendingInviteToken=params.get('invite');
let pendingCode=(params.get('code')||'').toUpperCase();
if(pendingInviteToken||pendingCode)history.replaceState({},'',location.pathname);

async function load(){
  const m=await api('/api/me'); me=m.user;
  if(!me){$('#authSection').classList.remove('hidden');$('#app').classList.add('hidden');$('#logout').classList.add('hidden');renderAuth();return}
  $('#authSection').classList.add('hidden');$('#app').classList.remove('hidden');$('#logout').classList.remove('hidden');
  if(pendingInviteToken){try{await api('/api/invites/accept',{method:'POST',body:JSON.stringify({token:pendingInviteToken})})}catch(e){alert(e.message)}pendingInviteToken=null}
  if(pendingCode){try{await api('/api/join',{method:'POST',body:JSON.stringify({code:pendingCode})})}catch(e){alert(e.message)}pendingCode=null}
  await loadDashboard();
  if(me.role==='global_admin'){$('#admin').classList.remove('hidden');renderAdmin()}else{$('#admin').classList.add('hidden')}
  showHome();
}

function renderAuth(){
  $all('[data-authtab]').forEach(b=>b.classList.toggle('active',b.dataset.authtab===authTab));
  if(authTab==='login'){
    $('#authPanel').innerHTML=`<h1>Welcome back</h1><p>Sign in to log activity and support your team.</p><form id="loginForm"><label>Email<input id="email" type="email" required></label><label>Password<input id="password" type="password" required></label><button>Sign in</button></form><p id="authMsg" class="error"></p>`;
    $('#loginForm').onsubmit=async e=>{e.preventDefault();try{await api('/api/login',{method:'POST',body:JSON.stringify({email:$('#email').value,password:$('#password').value})});await load()}catch(x){$('#authMsg').textContent=x.message}};
  }else{
    $('#authPanel').innerHTML=`<h1>Create your account</h1><p>Then create a challenge or join one with an invite code.</p><form id="registerForm"><label>Name<input id="rname" required></label><label>Email<input id="remail" type="email" required></label><label>Password<input id="rpassword" type="password" required minlength="8"></label><button>Create account</button></form><p id="authMsg" class="error"></p>`;
    $('#registerForm').onsubmit=async e=>{e.preventDefault();try{await api('/api/register',{method:'POST',body:JSON.stringify({name:$('#rname').value,email:$('#remail').value,password:$('#rpassword').value})});await load()}catch(x){$('#authMsg').textContent=x.message}};
  }
}
$all('[data-authtab]').forEach(b=>b.onclick=()=>{authTab=b.dataset.authtab;renderAuth()});

async function loadDashboard(){dash=await api('/api/dashboard')}

function showHome(){$('#challengeView').classList.add('hidden');$('#homeView').classList.remove('hidden');renderHome()}
function renderHome(){
  $('#hello').textContent=`Welcome, ${me.name}`;
  $('#challengeList').innerHTML=dash.challenges.map(c=>`<div class="listrow"><div><b>${esc(c.name)}</b><div class="muted">${c.start_date} → ${c.end_date} · ${c.teams.length} of your team(s) · ${esc(c.role)} · ${c.myMinutes} min logged</div></div><button data-open="${c.id}">Open</button></div>`).join('')||'<p class="muted">You have not joined a challenge yet. Create one or enter an invite code above.</p>';
  $all('[data-open]').forEach(b=>b.onclick=()=>openChallenge(Number(b.dataset.open)));
}

async function openChallenge(id){
  curChallenge=await api(`/api/challenges/${id}`);
  curLeaderboard=await api(`/api/challenges/${id}/leaderboard`);
  $('#homeView').classList.add('hidden');$('#challengeView').classList.remove('hidden');
  renderChallenge();
}
async function refreshChallenge(){
  await loadDashboard();
  curChallenge=await api(`/api/challenges/${curChallenge.id}`);
  curLeaderboard=await api(`/api/challenges/${curChallenge.id}/leaderboard`);
  renderChallenge();
}

function renderChallenge(){
  const c=curChallenge;
  $('#challengeName').textContent=c.name;
  $('#challengeDates').textContent=`${c.start_date} → ${c.end_date} · YOUR ROLE: ${c.role.toUpperCase()}`;
  $('#challengeCode').innerHTML=`Invite code: <b>${esc(c.invite_code)}</b> — share it so others can join this challenge.`;
  const mine=dash.challenges.find(x=>x.id===c.id);
  $('#myChMinutes').textContent=mine?mine.myMinutes:0;
  const myTeams=c.teams.filter(t=>t.mine);
  $('#team').innerHTML=myTeams.map(t=>`<option value="${t.id}">${esc(t.name)}</option>`).join('')||'<option value="">Join a team first</option>';
  $('#teamList').innerHTML=c.teams.map(t=>`<div class="listrow"><div><b>${esc(t.name)}</b><div class="muted">${t.members} member(s)${t.mine?' · you are in this team'+(t.invite_code?` · code: <b>${esc(t.invite_code)}</b>`:''):''}</div></div>${t.mine?'':`<button data-jointeam="${t.id}">Join</button>`}</div>`).join('')||'<p class="muted">No teams yet — create the first one.</p>';
  $all('[data-jointeam]').forEach(b=>b.onclick=async()=>{await api(`/api/teams/${b.dataset.jointeam}/join`,{method:'POST'});await refreshChallenge()});
  $('#teamLeaderboard').innerHTML=curLeaderboard.teams.map((t,i)=>`<div class="leader"><span class="rank">${i+1}</span><b>${esc(t.name)}</b><span>${t.minutes} min</span></div>`).join('')||'<p class="muted">No teams yet.</p>';
  $('#userLeaderboard').innerHTML=curLeaderboard.users.map((x,i)=>`<div class="leader"><span class="rank">${i+1}</span><b>${esc(x.name)}</b><span>${x.minutes} min</span></div>`).join('')||'<p class="muted">No members yet.</p>';
  const recent=dash.mine.filter(a=>a.challenge_id===c.id);
  $('#recent').innerHTML=recent.map(x=>`<div class="listrow"><div><b>${esc(x.activity_type)}</b><div class="muted">${esc(x.team_name)} · ${x.activity_date} · ${x.source}</div></div><b>${x.minutes} min</b></div>`).join('')||'<p class="muted">No activity logged yet in this challenge.</p>';
}

async function renderAdmin(){
  const u=await api('/api/admin/users');
  $('#adminPanel').innerHTML=`<form id="newUser" class="adminform"><label>Name<input name="name" required></label><label>Email<input name="email" type="email" required></label><label>Temporary password<input name="password" required></label><label>Role<select name="role"><option value="member">Member</option><option value="global_admin">Global admin</option></select></label><button>Create user</button></form>`+u.users.map(x=>`<div class="listrow"><span><b>${esc(x.name)}</b><small class="muted"> · ${esc(x.email)}</small></span><span>${esc(x.role)}</span></div>`).join('');
  $('#newUser').onsubmit=async e=>{e.preventDefault();await api('/api/admin/users',{method:'POST',body:JSON.stringify(Object.fromEntries(new FormData(e.target)))});renderAdmin()};
}

$('#logout').onclick=async()=>{await api('/api/logout',{method:'POST'});location.reload()};
$('#backHome').onclick=()=>showHome();
$('#joinForm').onsubmit=async e=>{e.preventDefault();try{await api('/api/join',{method:'POST',body:JSON.stringify({code:$('#joinCode').value})});$('#joinMsg').textContent='';e.target.reset();await loadDashboard();renderHome()}catch(x){$('#joinMsg').textContent=x.message}};
$('#newChallengeForm').onsubmit=async e=>{e.preventDefault();await api('/api/challenges',{method:'POST',body:JSON.stringify(Object.fromEntries(new FormData(e.target)))});e.target.reset();await loadDashboard();renderHome()};
$('#newTeamForm').onsubmit=async e=>{e.preventDefault();await api('/api/teams',{method:'POST',body:JSON.stringify({challenge_id:curChallenge.id,name:new FormData(e.target).get('name')})});e.target.reset();await refreshChallenge()};
$('#activityDate').value=new Date().toISOString().slice(0,10);
$('#activityForm').onsubmit=async e=>{e.preventDefault();const teamId=$('#team').value;if(!teamId){alert('Join a team first');return}await api('/api/activities',{method:'POST',body:JSON.stringify({team_id:teamId,challenge_id:curChallenge.id,activity_type:$('#activityType').value,minutes:$('#minutes').value,activity_date:$('#activityDate').value})});e.target.reset();$('#activityDate').value=new Date().toISOString().slice(0,10);await refreshChallenge()};
$('#health').onclick=()=>{$('#modalBody').innerHTML='<h2>Phone activity sync</h2><p><b>Android:</b> use the native companion app to read exercise sessions from Health Connect after the user grants permission.</p><p><b>iPhone:</b> use the native iOS companion app to read workouts from Apple Health through HealthKit.</p><p>This web app already includes the authenticated <code>/api/health/import</code> endpoint and duplicate protection. Native projects, store declarations and explicit user consent are still required.</p>';$('#modal').showModal()};

load();
