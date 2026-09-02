const $=s=>document.querySelector(s), $all=s=>[...document.querySelectorAll(s)];
const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const api=async(url,opt={})=>{const r=await fetch(url,{headers:{'Content-Type':'application/json'},...opt});const j=await r.json().catch(()=>({}));if(!r.ok)throw Error(j.error||'Request failed');return j};

let me=null, dash=null, curChallenge=null, curLeaderboard=null, authTab='login';
const params=new URLSearchParams(location.search);
let pendingInviteToken=params.get('invite');
let pendingCode=(params.get('code')||'').toUpperCase();
if(pendingInviteToken||pendingCode)history.replaceState({},'',location.pathname);

// reCAPTCHA is optional: /api/config only returns a site key once the server has one
// configured, so a deployment with no Google keys set just skips rendering the widget and the
// server-side check becomes a no-op too.
let recaptchaSiteKey=null, recaptchaWidgetId=null;
function renderRecaptchaIfReady(){
  const el=document.getElementById('recaptcha-auth');
  if(!el||!recaptchaSiteKey||!window.grecaptcha||!grecaptcha.render)return;
  el.innerHTML='';
  recaptchaWidgetId=grecaptcha.render(el,{sitekey:recaptchaSiteKey});
}
function getRecaptchaToken(){return (recaptchaSiteKey&&window.grecaptcha&&recaptchaWidgetId!==null)?grecaptcha.getResponse(recaptchaWidgetId):''}
function resetRecaptcha(){if(recaptchaSiteKey&&window.grecaptcha&&recaptchaWidgetId!==null)grecaptcha.reset(recaptchaWidgetId)}
async function initRecaptcha(){
  try{const cfg=await api('/api/config');recaptchaSiteKey=cfg.recaptchaSiteKey||null}catch(e){recaptchaSiteKey=null}
  if(!recaptchaSiteKey)return;
  window.onRecaptchaLoad=renderRecaptchaIfReady;
  const s=document.createElement('script');
  s.src='https://www.google.com/recaptcha/api.js?onload=onRecaptchaLoad&render=explicit';
  s.async=true;
  document.head.appendChild(s);
}
initRecaptcha();

async function load(){
  const m=await api('/api/me'); me=m.user;
  if(!me){$('#authSection').classList.remove('hidden');$('#app').classList.add('hidden');$('#logout').classList.add('hidden');$('#myAccount').classList.add('hidden');renderAuth();return}
  $('#authSection').classList.add('hidden');$('#app').classList.remove('hidden');$('#logout').classList.remove('hidden');$('#myAccount').classList.remove('hidden');
  if(pendingInviteToken){try{await api('/api/invites/accept',{method:'POST',body:JSON.stringify({token:pendingInviteToken})})}catch(e){alert(e.message)}pendingInviteToken=null}
  if(pendingCode){try{await api('/api/join',{method:'POST',body:JSON.stringify({code:pendingCode})})}catch(e){alert(e.message)}pendingCode=null}
  await loadDashboard();
  if(me.role==='global_admin'){$('#admin').classList.remove('hidden');renderAdmin()}else{$('#admin').classList.add('hidden')}
  showHome();
}

function renderAuth(){
  $all('[data-authtab]').forEach(b=>b.classList.toggle('active',b.dataset.authtab===authTab));
  if(authTab==='login'){
    $('#authPanel').innerHTML=`<h1>Welcome back</h1><p>Sign in to log activity and support your team.</p><form id="loginForm"><label>Email<input id="email" type="email" required></label><label>Password<input id="password" type="password" required></label><div id="recaptcha-auth"></div><button>Sign in</button></form><p id="authMsg" class="error"></p>`;
    $('#loginForm').onsubmit=async e=>{e.preventDefault();try{await api('/api/login',{method:'POST',body:JSON.stringify({email:$('#email').value,password:$('#password').value,recaptchaToken:getRecaptchaToken()})});await load()}catch(x){$('#authMsg').textContent=x.message;resetRecaptcha()}};
  }else{
    $('#authPanel').innerHTML=`<h1>Create your account</h1><p>Then create a challenge or join one with an invite code.</p><form id="registerForm"><label>Name<input id="rname" required></label><label>Email<input id="remail" type="email" required></label><label>Password<input id="rpassword" type="password" required minlength="8"></label><div id="recaptcha-auth"></div><button>Create account</button></form><p id="authMsg" class="error"></p>`;
    $('#registerForm').onsubmit=async e=>{e.preventDefault();try{await api('/api/register',{method:'POST',body:JSON.stringify({name:$('#rname').value,email:$('#remail').value,password:$('#rpassword').value,recaptchaToken:getRecaptchaToken()})});await load()}catch(x){$('#authMsg').textContent=x.message;resetRecaptcha()}};
  }
  renderRecaptchaIfReady();
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
  $('#challengeDescription').textContent=c.description||'';
  $('#challengeDescription').classList.toggle('hidden',!c.description);
  $('#challengeCode').innerHTML=`Invite code: <b>${esc(c.invite_code)}</b> — share it so others can join this challenge.`;
  $('#challengeActions').innerHTML=c.canManage?'<button class="ghost" data-editchallenge="1">Edit challenge</button>':'';
  if(c.canManage)$('[data-editchallenge]').onclick=()=>openEditChallenge(c);
  const mine=dash.challenges.find(x=>x.id===c.id);
  $('#myChMinutes').textContent=mine?mine.myMinutes:0;
  const myTeams=c.teams.filter(t=>t.mine);
  $('#team').innerHTML=myTeams.map(t=>`<option value="${t.id}">${esc(t.name)}</option>`).join('')||'<option value="">Join a team first</option>';
  $('#teamList').innerHTML=c.teams.map(t=>{
    const actions=[];
    if(!t.mine)actions.push(`<button data-jointeam="${t.id}">Join</button>`);
    if(t.canManage)actions.push(`<button class="ghost" data-manageteam="${t.id}" data-name="${esc(t.name)}">Manage</button>`);
    const bits=[`${t.members} member(s)`];
    if(t.mine)bits.push('you are in this team');
    if(t.invite_code)bits.push(`code: <b>${esc(t.invite_code)}</b>`);
    return `<div class="listrow"><div><b>${esc(t.name)}</b><div class="muted">${bits.join(' · ')}</div></div><div class="btnrow">${actions.join('')}</div></div>`;
  }).join('')||'<p class="muted">No teams yet — create the first one.</p>';
  $all('[data-jointeam]').forEach(b=>b.onclick=async()=>{await api(`/api/teams/${b.dataset.jointeam}/join`,{method:'POST'});await refreshChallenge()});
  $all('[data-manageteam]').forEach(b=>b.onclick=()=>openTeamManage(Number(b.dataset.manageteam),b.dataset.name));
  $('#teamLeaderboard').innerHTML=curLeaderboard.teams.map((t,i)=>`<div class="leader"><span class="rank">${i+1}</span><b>${esc(t.name)}</b><span>${t.minutes} min</span></div>`).join('')||'<p class="muted">No teams yet.</p>';
  $('#userLeaderboard').innerHTML=curLeaderboard.users.map((x,i)=>`<div class="leader"><span class="rank">${i+1}</span><b>${esc(x.name)}</b><span>${x.minutes} min</span></div>`).join('')||'<p class="muted">No members yet.</p>';
  const recent=dash.mine.filter(a=>a.challenge_id===c.id);
  $('#recent').innerHTML=recent.map(x=>{
    const timeBit=x.start_time&&x.end_time?` · ${x.start_time}–${x.end_time}`:'';
    return `<div class="listrow"><div><b>${esc(x.activity_type)}</b><div class="muted">${esc(x.team_name)} · ${x.activity_date}${timeBit} · ${x.source}</div></div><div class="btnrow"><b>${x.minutes} min</b><button class="ghost" data-editactivity="${x.id}">Edit</button><button class="ghost" data-delactivity="${x.id}">Delete</button></div></div>`;
  }).join('')||'<p class="muted">No activity logged yet in this challenge.</p>';
  $all('[data-editactivity]').forEach(b=>{const x=recent.find(a=>a.id===Number(b.dataset.editactivity));b.onclick=()=>openEditActivity(x)});
  $all('[data-delactivity]').forEach(b=>b.onclick=async()=>{
    if(!confirm('Delete this activity entry?'))return;
    try{await api(`/api/activities/${b.dataset.delactivity}`,{method:'DELETE'});await refreshChallenge()}catch(e){alert(e.message)}
  });
}

function openEditChallenge(c){
  $('#modalBody').innerHTML=`<h2>Edit challenge</h2>
    <form id="editChallengeForm">
      <label>Name<input id="ecName" value="${esc(c.name)}" required></label>
      <label>Description (optional)<textarea id="ecDescription" rows="3">${esc(c.description||'')}</textarea></label>
      <div class="two"><label>Start<input id="ecStart" type="date" value="${c.start_date}" required></label><label>End<input id="ecEnd" type="date" value="${c.end_date}" required></label></div>
      <button>Save changes</button>
    </form>
    <p id="ecMsg" class="error"></p>`;
  $('#modal').showModal();
  $('#editChallengeForm').onsubmit=async e=>{
    e.preventDefault();
    try{
      await api(`/api/challenges/${c.id}`,{method:'PATCH',body:JSON.stringify({name:$('#ecName').value.trim(),description:$('#ecDescription').value.trim(),start_date:$('#ecStart').value,end_date:$('#ecEnd').value})});
      $('#modal').close();
      await refreshChallenge();
    }catch(x){$('#ecMsg').textContent=x.message}
  };
}

// If both start and finish are set, minutes is derived from the gap between them and kept in
// sync as either changes; leaving one or both blank leaves minutes as a plain manual entry.
function minutesBetween(start,end){
  if(!start||!end)return null;
  const [sh,sm]=start.split(':').map(Number),[eh,em]=end.split(':').map(Number);
  const diff=(eh*60+em)-(sh*60+sm);
  return diff>0?diff:null;
}

function openEditActivity(x){
  $('#modalBody').innerHTML=`<h2>Edit activity</h2>
    <form id="editActivityForm">
      <label>Activity<input id="eaType" value="${esc(x.activity_type)}" required></label>
      <div class="two"><label>Minutes<input id="eaMinutes" type="number" min="1" value="${x.minutes}" required></label><label>Date<input id="eaDate" type="date" value="${x.activity_date}" required></label></div>
      <div class="two"><label>Start time (optional)<input id="eaStart" type="time" value="${x.start_time||''}"></label><label>Finish time (optional)<input id="eaEnd" type="time" value="${x.end_time||''}"></label></div>
      <button>Save changes</button>
    </form>
    <p id="eaMsg" class="error"></p>`;
  $('#modal').showModal();
  const recalc=()=>{const m=minutesBetween($('#eaStart').value,$('#eaEnd').value);if(m)$('#eaMinutes').value=m};
  $('#eaStart').addEventListener('change',recalc);
  $('#eaEnd').addEventListener('change',recalc);
  $('#editActivityForm').onsubmit=async e=>{
    e.preventDefault();
    try{
      await api(`/api/activities/${x.id}`,{method:'PATCH',body:JSON.stringify({activity_type:$('#eaType').value,minutes:$('#eaMinutes').value,activity_date:$('#eaDate').value,start_time:$('#eaStart').value,end_time:$('#eaEnd').value})});
      $('#modal').close();
      await refreshChallenge();
    }catch(err){$('#eaMsg').textContent=err.message}
  };
}

async function openTeamManage(tid,tname){
  const data=await api(`/api/teams/${tid}/members`);
  $('#modalBody').innerHTML=`<h2>Manage ${esc(tname)}</h2>
    <form id="renameTeamForm"><label>Team name<input id="renameTeamName" value="${esc(tname)}" required></label><button>Save name</button></form>
    <h2 style="margin-top:24px">Members</h2>
    <div id="teamMembersList">${data.members.map(m=>`<div class="listrow"><div><b>${esc(m.name)}</b><div class="muted">${esc(m.email)} · ${esc(m.team_role)}</div></div><button class="ghost" data-removemember="${m.id}">Remove</button></div>`).join('')||'<p class="muted">No members.</p>'}</div>
    <form id="addMemberForm"><label>Add someone by email<input id="addMemberEmail" type="email" required placeholder="name@example.com"></label><button>Add to team</button></form>
    <p id="manageMsg" class="error"></p>
    <hr><button id="deleteTeamBtn" class="ghost" style="color:var(--red)">Delete this team</button>`;
  $('#modal').showModal();
  $('#renameTeamForm').onsubmit=async e=>{
    e.preventDefault();
    const name=$('#renameTeamName').value.trim();
    if(!name)return;
    try{await api(`/api/teams/${tid}`,{method:'PATCH',body:JSON.stringify({name})});$('#modal').close();await refreshChallenge()}catch(x){$('#manageMsg').textContent=x.message}
  };
  $('#addMemberForm').onsubmit=async e=>{
    e.preventDefault();
    try{await api(`/api/teams/${tid}/members`,{method:'POST',body:JSON.stringify({email:$('#addMemberEmail').value})});await openTeamManage(tid,tname);await refreshChallenge()}catch(x){$('#manageMsg').textContent=x.message}
  };
  $all('[data-removemember]').forEach(b=>b.onclick=async()=>{
    if(!confirm('Remove this person from the team?'))return;
    try{await api(`/api/teams/${tid}/members/${b.dataset.removemember}`,{method:'DELETE'});await openTeamManage(tid,tname);await refreshChallenge()}catch(x){$('#manageMsg').textContent=x.message}
  });
  $('#deleteTeamBtn').onclick=async()=>{
    if(!confirm(`Delete team "${tname}"? This removes its members and any activity logged under it. This cannot be undone.`))return;
    try{await api(`/api/teams/${tid}`,{method:'DELETE'});$('#modal').close();await refreshChallenge()}catch(x){$('#manageMsg').textContent=x.message}
  };
}

async function renderAdmin(){
  const data=await api('/api/admin/users');
  $('#adminPanel').innerHTML=`<form id="newUser" class="adminform"><label>Name<input name="name" required></label><label>Email<input name="email" type="email" required></label><label>Temporary password<input name="password" required></label><label>Role<select name="role"><option value="member">Member</option><option value="global_admin">Global admin</option></select></label><button>Create user</button></form>`+data.users.map(x=>`<div class="listrow"><span><b>${esc(x.name)}</b><small class="muted"> · ${esc(x.email)}</small></span><span class="btnrow"><span class="muted">${esc(x.role)}</span><button class="ghost" data-edituser="${x.id}">Edit</button></span></div>`).join('');
  $('#newUser').onsubmit=async e=>{e.preventDefault();await api('/api/admin/users',{method:'POST',body:JSON.stringify(Object.fromEntries(new FormData(e.target)))});renderAdmin()};
  $all('[data-edituser]').forEach(b=>{const x=data.users.find(x2=>x2.id===Number(b.dataset.edituser));b.onclick=()=>openEditUser(x)});
}

function openEditUser(x){
  $('#modalBody').innerHTML=`<h2>Edit ${esc(x.name)}</h2>
    <form id="editUserForm">
      <label>Name<input id="euName" value="${esc(x.name)}" required></label>
      <label>Email<input id="euEmail" type="email" value="${esc(x.email)}" required></label>
      <label>Role<select id="euRole"><option value="member"${x.role==='member'?' selected':''}>Member</option><option value="global_admin"${x.role==='global_admin'?' selected':''}>Global admin</option></select></label>
      <label>Reset password (leave blank to keep current)<input id="euPassword" type="password" minlength="8"></label>
      <button>Save changes</button>
    </form>
    <p id="euMsg" class="error"></p>`;
  $('#modal').showModal();
  $('#editUserForm').onsubmit=async e=>{
    e.preventDefault();
    const payload={name:$('#euName').value.trim(),email:$('#euEmail').value.trim(),role:$('#euRole').value};
    const pw=$('#euPassword').value;
    if(pw)payload.password=pw;
    try{await api(`/api/admin/users/${x.id}`,{method:'PATCH',body:JSON.stringify(payload)});$('#modal').close();renderAdmin()}catch(err){$('#euMsg').textContent=err.message}
  };
}

function openMyAccount(){
  $('#modalBody').innerHTML=`<h2>My account</h2>
    <form id="accountForm">
      <label>Name<input id="acctName" value="${esc(me.name)}" required></label>
      <label>Email<input id="acctEmail" type="email" value="${esc(me.email)}" required></label>
      <label>New password (leave blank to keep current)<input id="acctNewPassword" type="password" minlength="8"></label>
      <label>Current password (required to change email or password)<input id="acctCurrentPassword" type="password"></label>
      <button>Save changes</button>
    </form>
    <p id="acctMsg" class="error"></p>`;
  $('#modal').showModal();
  $('#accountForm').onsubmit=async e=>{
    e.preventDefault();
    const payload={name:$('#acctName').value.trim(),email:$('#acctEmail').value.trim()};
    const newPassword=$('#acctNewPassword').value;
    if(newPassword)payload.newPassword=newPassword;
    const currentPassword=$('#acctCurrentPassword').value;
    if(currentPassword)payload.currentPassword=currentPassword;
    try{
      const r=await api('/api/me',{method:'PATCH',body:JSON.stringify(payload)});
      me=r.user;
      $('#modal').close();
      renderHome();
    }catch(x){$('#acctMsg').textContent=x.message}
  };
}
$('#myAccount').onclick=openMyAccount;

$('#logout').onclick=async()=>{await api('/api/logout',{method:'POST'});location.reload()};
$('#backHome').onclick=()=>showHome();
$('#joinForm').onsubmit=async e=>{e.preventDefault();try{await api('/api/join',{method:'POST',body:JSON.stringify({code:$('#joinCode').value})});$('#joinMsg').textContent='';e.target.reset();await loadDashboard();renderHome()}catch(x){$('#joinMsg').textContent=x.message}};
$('#newChallengeForm').onsubmit=async e=>{e.preventDefault();await api('/api/challenges',{method:'POST',body:JSON.stringify(Object.fromEntries(new FormData(e.target)))});e.target.reset();await loadDashboard();renderHome()};
$('#newTeamForm').onsubmit=async e=>{e.preventDefault();await api('/api/teams',{method:'POST',body:JSON.stringify({challenge_id:curChallenge.id,name:new FormData(e.target).get('name')})});e.target.reset();await refreshChallenge()};
$('#activityDate').value=new Date().toISOString().slice(0,10);
$('#startTime').addEventListener('change',()=>{const m=minutesBetween($('#startTime').value,$('#endTime').value);if(m)$('#minutes').value=m});
$('#endTime').addEventListener('change',()=>{const m=minutesBetween($('#startTime').value,$('#endTime').value);if(m)$('#minutes').value=m});
$('#activityForm').onsubmit=async e=>{
  e.preventDefault();
  const teamId=$('#team').value;
  if(!teamId){alert('Join a team first');return}
  try{
    await api('/api/activities',{method:'POST',body:JSON.stringify({team_id:teamId,challenge_id:curChallenge.id,activity_type:$('#activityType').value,minutes:$('#minutes').value,activity_date:$('#activityDate').value,start_time:$('#startTime').value,end_time:$('#endTime').value})});
    $('#activityMsg').textContent='';
    e.target.reset();
    $('#activityDate').value=new Date().toISOString().slice(0,10);
    await refreshChallenge();
  }catch(x){$('#activityMsg').textContent=x.message}
};
$('#health').onclick=()=>{$('#modalBody').innerHTML='<h2>Phone activity sync</h2><p><b>Android:</b> use the native companion app to read exercise sessions from Health Connect after the user grants permission.</p><p><b>iPhone:</b> use the native iOS companion app to read workouts from Apple Health through HealthKit.</p><p>This web app already includes the authenticated <code>/api/health/import</code> endpoint and duplicate protection. Native projects, store declarations and explicit user consent are still required.</p>';$('#modal').showModal()};

load();
