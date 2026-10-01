const $=s=>document.querySelector(s), $all=s=>[...document.querySelectorAll(s)];
const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const api=async(url,opt={})=>{const r=await fetch(url,{headers:{'Content-Type':'application/json'},...opt});const j=await r.json().catch(()=>({}));if(!r.ok)throw Error(j.error||'Request failed');return j};

// --- image upload: resize client-side (canvas) before sending, server enforces a 10MB hard cap
// as a backstop. The server never trusts our chosen mime type either way - it sniffs the bytes.
async function resizeImageFile(file,maxDim,quality){
  const bitmap=await createImageBitmap(file);
  let {width,height}=bitmap;
  if(width>maxDim||height>maxDim){const scale=maxDim/Math.max(width,height);width=Math.round(width*scale);height=Math.round(height*scale)}
  const canvas=document.createElement('canvas');
  canvas.width=width;canvas.height=height;
  canvas.getContext('2d').drawImage(bitmap,0,0,width,height);
  return new Promise((resolve,reject)=>canvas.toBlob(blob=>{
    if(!blob){reject(Error('Could not process that image'));return}
    const reader=new FileReader();
    reader.onload=()=>resolve(reader.result);
    reader.onerror=()=>reject(Error('Could not read that image'));
    reader.readAsDataURL(blob);
  },'image/jpeg',quality));
}
async function uploadImageFile(file,maxDim=900,quality=0.85){
  if(file.size>10*1024*1024)throw Error('Image is too large (max 10MB).');
  const dataUrl=await resizeImageFile(file,maxDim,quality);
  const r=await api('/api/uploads',{method:'POST',body:JSON.stringify({dataUrl})});
  return r.url;
}

// --- rich text editor: contenteditable + document.execCommand, no library. The server is the
// real sanitization boundary (this HTML is sent as-is and trusted only once the server has
// cleaned it); this editor just gives the user a small, safe-by-construction toolbar so nothing
// they can produce through it needs sanitizing in the first place.
function initRichTextEditor(root){
  const editor=root.querySelector('.rte-editor');
  root.querySelectorAll('[data-cmd]').forEach(btn=>{
    btn.onclick=async()=>{
      const cmd=btn.dataset.cmd;
      editor.focus();
      if(cmd==='createLink'){
        const url=prompt('Link URL (https://...)');
        if(url)document.execCommand('createLink',false,url);
      }else if(cmd==='insertImage'){
        const input=document.createElement('input');
        input.type='file';input.accept='image/*';
        input.onchange=async()=>{
          const file=input.files[0];
          if(!file)return;
          try{const url=await uploadImageFile(file,900,0.82);editor.focus();document.execCommand('insertHTML',false,`<img src="${url}" alt="">`)}
          catch(e){alert(e.message)}
        };
        input.click();
      }else{
        document.execCommand(cmd,false,null);
      }
    };
  });
}

let me=null, dash=null, curChallenge=null, curLeaderboard=null, authTab='login';

// --- what a challenge measures: active minutes (the default) or distance in miles/km ---------
const isDistance=c=>c&&c.metric==='distance';
// Individuals-only challenges have no teams: activity is logged straight to the challenge.
const isIndividual=c=>!!c&&c.participation==='individual';
const unitShort=c=>c&&c.distance_unit==='km'?'km':'mi';
const unitLong=c=>c&&c.distance_unit==='km'?'Kilometres':'Miles';
const fmtNum=n=>Number(n||0).toLocaleString(undefined,{maximumFractionDigits:2});
// The challenge's own measure, e.g. "12.4 mi" or "340 min".
function fmtTotal(c,minutes,distance){return isDistance(c)?`${fmtNum(distance)} ${unitShort(c)}`:`${fmtNum(minutes)} min`}
// One activity: both figures when it has both, the challenge's measure first.
function fmtEntry(c,x){
  const d=x.distance!=null?`${fmtNum(x.distance)} ${unitShort(c)}`:'',m=x.minutes!=null?`${fmtNum(x.minutes)} min`:'';
  return (isDistance(c)?[d,m]:[m,d]).filter(Boolean).join(' · ');
}
// Show the unit picker only while Distance is chosen.
function wireMeasureFields(form){
  const sel=form.querySelector('[data-metric]'),wrap=form.querySelector('[data-unitwrap]');
  const sync=()=>wrap.classList.toggle('hidden',sel.value!=='distance');
  sel.addEventListener('change',sync);sync();
  return sync;
}
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
    $('#authPanel').innerHTML=`<h1>Create your account</h1><p>Then create a challenge or join one with an invite code.</p><form id="registerForm"><label>Name<input id="rname" required></label><label>Email<input id="remail" type="email" required></label><label>Password<input id="rpassword" type="password" required minlength="8"></label><div id="recaptcha-auth"></div><button>Create account</button></form><p class="muted">By creating an account you agree to our <a href="privacy.html" target="_blank" rel="noopener">Privacy Policy</a>.</p><p id="authMsg" class="error"></p>`;
    $('#registerForm').onsubmit=async e=>{e.preventDefault();try{await api('/api/register',{method:'POST',body:JSON.stringify({name:$('#rname').value,email:$('#remail').value,password:$('#rpassword').value,recaptchaToken:getRecaptchaToken()})});await load()}catch(x){$('#authMsg').textContent=x.message;resetRecaptcha()}};
  }
  renderRecaptchaIfReady();
}
$all('[data-authtab]').forEach(b=>b.onclick=()=>{authTab=b.dataset.authtab;renderAuth()});

async function loadDashboard(){dash=await api('/api/dashboard')}

function showHome(){$('#challengeView').classList.add('hidden');$('#homeView').classList.remove('hidden');renderHome()}
function renderHome(){
  $('#hello').textContent=`Welcome, ${me.name}`;
  $('#challengeList').innerHTML=dash.challenges.map(c=>`<div class="listrow"><div><b>${esc(c.name)}</b><div class="muted">${c.start_date} → ${c.end_date} · ${isIndividual(c)?'individuals':`${c.teams.length} of your team(s)`} · ${esc(c.role)} · ${esc(fmtTotal(c,c.myMinutes,c.myDistance))} logged</div></div><button data-open="${c.id}">Open</button></div>`).join('')||'<p class="muted">You have not joined a challenge yet. Create one or enter an invite code above.</p>';
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

function avatarHtml(url,name,cls){
  return url?`<img src="${esc(url)}" class="${cls}" alt="">`:`<span class="${cls} avatar-placeholder">${esc((name||'?')[0].toUpperCase())}</span>`;
}

function renderChallenge(){
  const c=curChallenge;
  $('#challengeName').textContent=c.name;
  $('#challengeDates').textContent=`${c.start_date} → ${c.end_date} · YOUR ROLE: ${c.role.toUpperCase()}`;
  // The server already sanitized this on write (POST/PATCH /api/challenges) - safe to render as-is.
  $('#challengeDescription').innerHTML=c.description||'';
  $('#challengeDescription').classList.toggle('hidden',!c.description);
  $('#challengeCode').innerHTML=`Invite code: <b>${esc(c.invite_code)}</b> — share it so others can join this challenge.`;
  $('#challengeActions').innerHTML=c.canManage?'<button class="ghost" data-editchallenge="1">Edit challenge</button>':'';
  if(c.canManage)$('[data-editchallenge]').onclick=()=>openEditChallenge(c);
  $('#exportTeamsCsv').classList.toggle('hidden',!c.canManage);
  $('#exportUsersCsv').classList.toggle('hidden',!c.canManage);
  if(c.canManage){$('#exportTeamsCsv').href=`/api/challenges/${c.id}/leaderboard/export?type=teams`;$('#exportUsersCsv').href=`/api/challenges/${c.id}/leaderboard/export?type=users`}
  const mine=dash.challenges.find(x=>x.id===c.id);
  $('#myChMinutes').textContent=fmtNum(mine?(isDistance(c)?mine.myDistance:mine.myMinutes):0);
  $('#myChMetricLabel').textContent=isDistance(c)?`my ${unitLong(c).toLowerCase()}`:'my minutes';
  // A distance challenge asks for distance and makes minutes optional; a minutes challenge is unchanged.
  $('#distanceWrap').classList.toggle('hidden',!isDistance(c));
  $('#distance').required=isDistance(c);
  // Either unit can be entered - the server converts. Defaults to the challenge's own unit each
  // time a different challenge is opened, but keeps the person's choice while they stay on it.
  if($('#distanceUnit').dataset.cid!==String(c.id)){$('#distanceUnit').value=unitShort(c);$('#distanceUnit').dataset.cid=String(c.id)}
  $('#minutes').required=!isDistance(c);
  $('#minutesLabel').textContent=isDistance(c)?'Minutes (optional)':'Minutes';
  const solo=isIndividual(c);
  ['#teamsCard','#teamLeaderCard','#teamWrap'].forEach(s=>$(s).classList.toggle('hidden',solo));
  if(solo)$('#exportTeamsCsv').classList.add('hidden');
  $('#logGrid').classList.toggle('single',solo);
  $('#boardGrid').classList.toggle('single',solo);
  $('#team').required=!solo;
  const myTeams=c.teams.filter(t=>t.mine);
  $('#team').innerHTML=myTeams.map(t=>`<option value="${t.id}">${esc(t.name)}</option>`).join('')||'<option value="">Join a team first</option>';
  $('#teamList').innerHTML=c.teams.map(t=>{
    const actions=[];
    if(!t.mine)actions.push(`<button data-jointeam="${t.id}">Join</button>`);
    if(t.canManage)actions.push(`<button class="ghost" data-manageteam="${t.id}" data-name="${esc(t.name)}">Manage</button>`);
    const bits=[`${t.members} member(s)`];
    if(t.mine)bits.push('you are in this team');
    if(t.invite_code)bits.push(`code: <b>${esc(t.invite_code)}</b>`);
    return `<div class="listrow"><div class="leader-name">${avatarHtml(t.image_url,t.name,'logo-sm')}<div><b>${esc(t.name)}</b><div class="muted">${bits.join(' · ')}</div></div></div><div class="btnrow">${actions.join('')}</div></div>`;
  }).join('')||'<p class="muted">No teams yet — create the first one.</p>';
  $all('[data-jointeam]').forEach(b=>b.onclick=async()=>{await api(`/api/teams/${b.dataset.jointeam}/join`,{method:'POST'});await refreshChallenge()});
  $all('[data-manageteam]').forEach(b=>b.onclick=()=>openTeamManage(Number(b.dataset.manageteam),b.dataset.name));
  $('#teamLeaderboard').innerHTML=curLeaderboard.teams.map((t,i)=>`<div class="leader"><span class="rank">${i+1}</span><span class="leader-name">${avatarHtml(t.image_url,t.name,'logo-sm')}<b>${esc(t.name)}</b></span><span>${esc(fmtTotal(c,t.minutes,t.distance))}</span></div>`).join('')||'<p class="muted">No teams yet.</p>';
  $('#userLeaderboard').innerHTML=curLeaderboard.users.map((x,i)=>`<div class="leader"><span class="rank">${i+1}</span><span class="leader-name">${avatarHtml(x.avatar_url,x.name,'avatar-sm')}<b>${esc(x.name)}</b></span><span>${esc(fmtTotal(c,x.minutes,x.distance))}</span></div>`).join('')||'<p class="muted">No members yet.</p>';
  const recent=dash.mine.filter(a=>a.challenge_id===c.id);
  $('#recent').innerHTML=recent.map(x=>{
    const timeBit=x.start_time&&x.end_time?` · ${x.start_time}–${x.end_time}`:'';
    const commentBit=x.comment?`<div class="muted">“${esc(x.comment)}”</div>`:'';
    return `<div class="listrow"><div><b>${esc(x.activity_type)}</b><div class="muted">${x.team_name?`${esc(x.team_name)} · `:''}${x.activity_date}${timeBit} · ${x.source}</div>${commentBit}</div><div class="btnrow"><b>${esc(fmtEntry(c,x))}</b><button class="ghost" data-editactivity="${x.id}">Edit</button><button class="ghost" data-delactivity="${x.id}">Delete</button></div></div>`;
  }).join('')||'<p class="muted">No activity logged yet in this challenge.</p>';
  $all('[data-editactivity]').forEach(b=>{const x=recent.find(a=>a.id===Number(b.dataset.editactivity));b.onclick=()=>openEditActivity(x)});
  $all('[data-delactivity]').forEach(b=>b.onclick=async()=>{
    if(!confirm('Delete this activity entry?'))return;
    try{await api(`/api/activities/${b.dataset.delactivity}`,{method:'DELETE'});await refreshChallenge()}catch(e){alert(e.message)}
  });
}

async function openEditChallenge(c){
  const membersData=await api(`/api/challenges/${c.id}/members`);
  $('#modalBody').innerHTML=`<h2>Edit challenge</h2>
    <form id="editChallengeForm">
      <label>Name<input id="ecName" value="${esc(c.name)}" required></label>
      <label>Description (optional)</label>
      <div class="rte" data-rte><div class="rte-toolbar"><button type="button" data-cmd="bold" title="Bold"><b>B</b></button><button type="button" data-cmd="italic" title="Italic"><i>I</i></button><button type="button" data-cmd="insertUnorderedList" title="Bullet list">&bull; List</button><button type="button" data-cmd="insertOrderedList" title="Numbered list">1. List</button><button type="button" data-cmd="createLink" title="Link">Link</button><button type="button" data-cmd="insertImage" title="Insert image">Image</button></div><div id="ecDescription" class="rte-editor" contenteditable="true" data-placeholder="What's this challenge about?">${c.description||''}</div></div>
      <div class="two"><label>Start<input id="ecStart" type="date" value="${c.start_date}" required></label><label>End<input id="ecEnd" type="date" value="${c.end_date}" required></label></div>
      <div class="two"><label>Measure<select id="ecMetric" data-metric><option value="minutes"${isDistance(c)?'':' selected'}>Active minutes</option><option value="distance"${isDistance(c)?' selected':''}>Distance</option></select></label><label data-unitwrap>Distance unit<select id="ecUnit"><option value="mi"${unitShort(c)==='mi'?' selected':''}>Miles</option><option value="km"${unitShort(c)==='km'?' selected':''}>Kilometres</option></select></label></div>
      <p class="muted">Changing what the challenge measures re-ranks the leaderboards. Entries logged without that measure count as zero toward it.</p>
      <label>Who takes part<select id="ecParticipation"><option value="teams"${isIndividual(c)?'':' selected'}>Teams</option><option value="individual"${isIndividual(c)?' selected':''}>Individuals only</option></select></label>
      <p class="muted">Individuals only hides teams: everyone logs straight to the challenge. Activity already logged with a team still counts on the individual leaderboard.</p>
      <button>Save changes</button>
    </form>
    <p id="ecMsg" class="error"></p>
    <h2 style="margin-top:24px">Challenge owners</h2>
    <div id="ownersList">${membersData.members.filter(m=>m.challenge_role==='owner').map(m=>`<div class="listrow"><div><b>${esc(m.name)}</b><div class="muted">${esc(m.email)}</div></div></div>`).join('')||'<p class="muted">No owners.</p>'}</div>
    <form id="addOwnerForm"><label>Add an owner by email<input id="addOwnerEmail" type="email" required placeholder="name@example.com"></label><button>Add owner</button></form>
    <p id="ownerMsg" class="error"></p>
    <div class="danger-zone"><h2>Delete challenge</h2><p class="muted">Permanently deletes this challenge with all its teams, members and logged activity, for everyone. This cannot be undone.</p><button type="button" class="danger" id="deleteChallengeBtn">Delete challenge</button><p id="deleteChallengeMsg" class="error"></p></div>`;
  $('#modal').showModal();
  initRichTextEditor($('[data-rte]'));
  wireMeasureFields($('#editChallengeForm'));
  $('#editChallengeForm').onsubmit=async e=>{
    e.preventDefault();
    try{
      await api(`/api/challenges/${c.id}`,{method:'PATCH',body:JSON.stringify({name:$('#ecName').value.trim(),description:$('#ecDescription').innerHTML,start_date:$('#ecStart').value,end_date:$('#ecEnd').value,metric:$('#ecMetric').value,distance_unit:$('#ecUnit').value,participation:$('#ecParticipation').value})});
      $('#modal').close();
      await refreshChallenge();
    }catch(x){$('#ecMsg').textContent=x.message}
  };
  // Typing the name is the confirmation: deleting removes everyone's activity, not just the owner's.
  $('#deleteChallengeBtn').onclick=async()=>{
    const typed=prompt(`This deletes "${c.name}" and everything logged in it, for every member. Type the challenge name to confirm.`);
    if(typed===null)return;
    if(typed.trim()!==c.name.trim()){$('#deleteChallengeMsg').textContent='The name did not match, so nothing was deleted.';return}
    try{
      await api(`/api/challenges/${c.id}`,{method:'DELETE'});
      $('#modal').close();
      curChallenge=null;
      await loadDashboard();
      showHome();
    }catch(x){$('#deleteChallengeMsg').textContent=x.message}
  };
  $('#addOwnerForm').onsubmit=async e=>{
    e.preventDefault();
    try{await api(`/api/challenges/${c.id}/owners`,{method:'POST',body:JSON.stringify({email:$('#addOwnerEmail').value})});await openEditChallenge(c)}catch(x){$('#ownerMsg').textContent=x.message}
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
  const c=curChallenge,dist=isDistance(c);
  // Distance is shown whenever the challenge measures it, or the entry already has one.
  const distField=dist||x.distance!=null?`<label>Distance${dist?'':' (optional)'}<span class="with-unit"><input id="eaDistance" type="number" min="0.01" step="0.01" inputmode="decimal" value="${x.distance??''}"${dist?' required':''}><select id="eaUnit" aria-label="Distance unit"><option value="mi">miles</option><option value="km">km</option></select></span></label>`:'';
  $('#modalBody').innerHTML=`<h2>Edit activity</h2>
    <form id="editActivityForm">
      <label>Activity<input id="eaType" value="${esc(x.activity_type)}" required></label>
      <div class="two">${distField}<label>Minutes${dist?' (optional)':''}<input id="eaMinutes" type="number" min="1" value="${x.minutes??''}"${dist?'':' required'}></label><label>Date<input id="eaDate" type="date" value="${x.activity_date}" required></label></div>
      <div class="two"><label>Start time (optional)<input id="eaStart" type="time" value="${x.start_time||''}"></label><label>Finish time (optional)<input id="eaEnd" type="time" value="${x.end_time||''}"></label></div>
      <label>Comment (optional)<input id="eaComment" maxlength="500" value="${esc(x.comment||'')}" placeholder="How did it go?"></label>
      <button>Save changes</button>
    </form>
    <p id="eaMsg" class="error"></p>`;
  $('#modal').showModal();
  // The stored distance arrives in the challenge's unit; switching unit converts it until the
  // number itself is edited, after which the number is taken as meant in the chosen unit.
  if($('#eaUnit')){
    $('#eaUnit').value=unitShort(c);
    let edited=false;
    $('#eaDistance').addEventListener('input',()=>{edited=true});
    $('#eaUnit').addEventListener('change',()=>{
      if(edited||x.distance==null)return;
      const perMile=1.609344,v=Number(x.distance);
      $('#eaDistance').value=String(Math.round((unitShort(c)===$('#eaUnit').value?v:$('#eaUnit').value==='km'?v*perMile:v/perMile)*100)/100);
    });
  }
  const recalc=()=>{const m=minutesBetween($('#eaStart').value,$('#eaEnd').value);if(m)$('#eaMinutes').value=m};
  $('#eaStart').addEventListener('change',recalc);
  $('#eaEnd').addEventListener('change',recalc);
  $('#editActivityForm').onsubmit=async e=>{
    e.preventDefault();
    try{
      await api(`/api/activities/${x.id}`,{method:'PATCH',body:JSON.stringify({activity_type:$('#eaType').value,minutes:$('#eaMinutes').value,...($('#eaDistance')?{distance:$('#eaDistance').value,distance_unit:$('#eaUnit').value}:{}),activity_date:$('#eaDate').value,start_time:$('#eaStart').value,end_time:$('#eaEnd').value,comment:$('#eaComment').value})});
      $('#modal').close();
      await refreshChallenge();
    }catch(err){$('#eaMsg').textContent=err.message}
  };
}

async function openTeamManage(tid,tname){
  const data=await api(`/api/teams/${tid}/members`);
  const team=curChallenge.teams.find(t=>t.id===tid);
  $('#modalBody').innerHTML=`<h2>Manage ${esc(tname)}</h2>
    <form id="renameTeamForm">
      <label>Team name<input id="renameTeamName" value="${esc(tname)}" required></label>
      <label>Team image/logo (optional)<input type="file" id="renameTeamImage" accept="image/*"></label>
      <img id="renameTeamImagePreview" class="imgpreview${team&&team.image_url?'':' hidden'}" src="${team&&team.image_url?esc(team.image_url):''}" alt="Preview">
      <button>Save changes</button>
    </form>
    <h2 style="margin-top:24px">Members</h2>
    <div id="teamMembersList">${data.members.map(m=>`<div class="listrow"><div><b>${esc(m.name)}</b><div class="muted">${esc(m.email)} · ${esc(m.team_role)}</div></div><button class="ghost" data-removemember="${m.id}">Remove</button></div>`).join('')||'<p class="muted">No members.</p>'}</div>
    <form id="addMemberForm"><label>Add someone by email<input id="addMemberEmail" type="email" required placeholder="name@example.com"></label><button>Add to team</button></form>
    <p id="manageMsg" class="error"></p>
    <hr><button id="deleteTeamBtn" class="ghost" style="color:var(--red)">Delete this team</button>`;
  $('#modal').showModal();
  $('#renameTeamImage').addEventListener('change',()=>{
    const f=$('#renameTeamImage').files[0];
    if(!f)return;
    $('#renameTeamImagePreview').src=URL.createObjectURL(f);
    $('#renameTeamImagePreview').classList.remove('hidden');
  });
  $('#renameTeamForm').onsubmit=async e=>{
    e.preventDefault();
    const name=$('#renameTeamName').value.trim();
    if(!name)return;
    const payload={name};
    const file=$('#renameTeamImage').files[0];
    try{
      if(file)payload.image_url=await uploadImageFile(file,400,0.85);
      await api(`/api/teams/${tid}`,{method:'PATCH',body:JSON.stringify(payload)});
      $('#modal').close();
      await refreshChallenge();
    }catch(x){$('#manageMsg').textContent=x.message}
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
      <label>Avatar (optional)</label>
      <div id="acctAvatarPreview">${avatarHtml(me.avatar_url,me.name,'imgpreview')}</div>
      <input type="file" id="acctAvatar" accept="image/*">
      <label>Name<input id="acctName" value="${esc(me.name)}" required></label>
      <label>Email<input id="acctEmail" type="email" value="${esc(me.email)}" required></label>
      <label>New password (leave blank to keep current)<input id="acctNewPassword" type="password" minlength="8"></label>
      <label>Current password (required to change email or password)<input id="acctCurrentPassword" type="password"></label>
      <button>Save changes</button>
    </form>
    <p id="acctMsg" class="error"></p>`;
  $('#modal').showModal();
  $('#acctAvatar').addEventListener('change',()=>{
    const f=$('#acctAvatar').files[0];
    if(!f)return;
    $('#acctAvatarPreview').innerHTML=`<img src="${URL.createObjectURL(f)}" class="imgpreview" alt="">`;
  });
  $('#accountForm').onsubmit=async e=>{
    e.preventDefault();
    const payload={name:$('#acctName').value.trim(),email:$('#acctEmail').value.trim()};
    const newPassword=$('#acctNewPassword').value;
    if(newPassword)payload.newPassword=newPassword;
    const currentPassword=$('#acctCurrentPassword').value;
    if(currentPassword)payload.currentPassword=currentPassword;
    const file=$('#acctAvatar').files[0];
    try{
      if(file)payload.avatarUrl=await uploadImageFile(file,320,0.85);
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
const newChallengeRte=document.querySelector('#newChallengeForm [data-rte]');
initRichTextEditor(newChallengeRte);
const syncNewChallengeMeasure=wireMeasureFields($('#newChallengeForm'));
$('#newChallengeForm').onsubmit=async e=>{
  e.preventDefault();
  const fields=Object.fromEntries(new FormData(e.target));
  fields.description=newChallengeRte.querySelector('.rte-editor').innerHTML;
  await api('/api/challenges',{method:'POST',body:JSON.stringify(fields)});
  e.target.reset();
  syncNewChallengeMeasure();
  newChallengeRte.querySelector('.rte-editor').innerHTML='';
  await loadDashboard();renderHome();
};
$('#newTeamImage').addEventListener('change',()=>{
  const f=$('#newTeamImage').files[0];
  if(!f){$('#newTeamImagePreview').classList.add('hidden');return}
  $('#newTeamImagePreview').src=URL.createObjectURL(f);
  $('#newTeamImagePreview').classList.remove('hidden');
});
$('#newTeamForm').onsubmit=async e=>{
  e.preventDefault();
  const file=$('#newTeamImage').files[0];
  const payload={challenge_id:curChallenge.id,name:new FormData(e.target).get('name')};
  try{
    if(file)payload.image_url=await uploadImageFile(file,400,0.85);
    await api('/api/teams',{method:'POST',body:JSON.stringify(payload)});
    e.target.reset();
    $('#newTeamImagePreview').classList.add('hidden');
    await refreshChallenge();
  }catch(err){alert(err.message)}
};
$('#activityDate').value=new Date().toISOString().slice(0,10);
$('#startTime').addEventListener('change',()=>{const m=minutesBetween($('#startTime').value,$('#endTime').value);if(m)$('#minutes').value=m});
$('#endTime').addEventListener('change',()=>{const m=minutesBetween($('#startTime').value,$('#endTime').value);if(m)$('#minutes').value=m});
$('#activityForm').onsubmit=async e=>{
  e.preventDefault();
  const solo=isIndividual(curChallenge),teamId=solo?null:$('#team').value;
  if(!solo&&!teamId){alert('Join a team first');return}
  try{
    await api('/api/activities',{method:'POST',body:JSON.stringify({...(solo?{}:{team_id:teamId}),challenge_id:curChallenge.id,activity_type:$('#activityType').value,minutes:$('#minutes').value,...(isDistance(curChallenge)?{distance:$('#distance').value,distance_unit:$('#distanceUnit').value}:{}),activity_date:$('#activityDate').value,start_time:$('#startTime').value,end_time:$('#endTime').value,comment:$('#activityComment').value})});
    $('#activityMsg').textContent='';
    const keepUnit=$('#distanceUnit').value;
    e.target.reset();
    $('#distanceUnit').value=keepUnit;
    $('#activityDate').value=new Date().toISOString().slice(0,10);
    await refreshChallenge();
  }catch(x){$('#activityMsg').textContent=x.message}
};
$('#health').onclick=()=>{$('#modalBody').innerHTML='<h2>Phone activity sync</h2><p><b>Android:</b> use the native companion app to read exercise sessions from Health Connect after the user grants permission.</p><p><b>iPhone:</b> use the native iOS companion app to read workouts from Apple Health through HealthKit.</p><p>This web app already includes the authenticated <code>/api/health/import</code> endpoint and duplicate protection. Native projects, store declarations and explicit user consent are still required.</p>';$('#modal').showModal()};

load();
