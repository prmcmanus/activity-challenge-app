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
const legacyCode=(params.get('code')||'').trim().toUpperCase();
// Older shared links used ?code=; they become /join/CODE like the new ones.
if(legacyCode)history.replaceState({},'',`/join/${encodeURIComponent(legacyCode)}`);
else if(pendingInviteToken)history.replaceState({},'',location.pathname);

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
  if(!me){showInviteBanner();$('#authSection').classList.remove('hidden');$('#app').classList.add('hidden');$('#logout').classList.add('hidden');$('#myAccount').classList.add('hidden');$('#helpBtn').classList.add('hidden');$('#adminBtn').classList.add('hidden');renderAuth();return}
  $('#authSection').classList.add('hidden');$('#app').classList.remove('hidden');$('#logout').classList.remove('hidden');$('#myAccount').classList.remove('hidden');$('#helpBtn').classList.remove('hidden');refreshHelpBadge();
  if(pendingInviteToken){try{await api('/api/invites/accept',{method:'POST',body:JSON.stringify({token:pendingInviteToken})})}catch(e){alert(e.message)}pendingInviteToken=null}
  await loadDashboard();
  $('#adminBtn').classList.toggle('hidden',me.role!=='global_admin');
  $('#inviteBanner').classList.add('hidden');
  await route();
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

// One view at a time: home, a challenge, help, or (global admins) the admin page.
function showView(id){['#homeView','#challengeView','#helpView','#adminView'].forEach(v=>$(v).classList.toggle('hidden',v!==id));window.scrollTo(0,0)}
function showHome(){challengeBack='home';setUrl('/');showView('#homeView');renderHome()}
function renderHome(){
  $('#hello').textContent=`Welcome, ${me.name}`;
  $('#challengeList').innerHTML=dash.challenges.map(c=>`<div class="listrow"><div><b>${esc(c.name)}</b><div class="muted">${c.start_date} → ${c.end_date} · ${isIndividual(c)?'individuals':`${c.teams.length} of your team(s)`} · ${esc(c.role)} · ${esc(fmtTotal(c,c.myMinutes,c.myDistance))} logged</div></div><button data-open="${c.id}">Open</button></div>`).join('')||'<p class="muted">You have not joined a challenge yet. Create one or enter an invite code above.</p>';
  $all('[data-open]').forEach(b=>b.onclick=()=>openChallenge(Number(b.dataset.open)));
  loadMyActivity().catch(()=>{});
  loadAndroidCard();
}
// Offer the Android app once it's published; shown on phones and computers alike (people often download on one and install on the other).
async function loadAndroidCard(){
  try{
    const a=await api('/api/app/android');
    $('#androidCard').classList.toggle('hidden',!a.available);
    if(a.available)$('#androidMeta').textContent=`Version ${a.version} · ${(a.size/1048576).toFixed(1)} MB`;
  }catch(e){$('#androidCard').classList.add('hidden')}
}

async function openChallenge(id){
  curChallenge=await api(`/api/challenges/${id}`);
  curLeaderboard=await api(`/api/challenges/${id}/leaderboard`);
  setUrl(`/challenges/${id}`);
  showView('#challengeView');
  $('#backHome').innerHTML=challengeBack==='admin'?'&larr; Admin':'&larr; My challenges';
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
  $('#challengeCode').innerHTML=`<span class="invite-box"><span class="invite-label">Invite people</span><span class="linkrow"><code>${esc(inviteUrl(c.invite_code))}</code><button type="button" data-copylink="${esc(c.invite_code)}">Copy link</button></span><span class="invite-note">Or share the code <b>${esc(c.invite_code)}</b>. Anyone with the link or code can join this challenge.</span></span>`;
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
  const solo=isIndividual(c),visiting=c.role==='admin';
  // A global admin looking at a challenge they have not joined manages it but has nothing to log.
  $('#logCard').classList.toggle('hidden',visiting);$('#recentCard').classList.toggle('hidden',visiting);
  ['#teamsCard','#teamLeaderCard','#teamWrap'].forEach(s=>$(s).classList.toggle('hidden',solo));
  if(solo)$('#exportTeamsCsv').classList.add('hidden');
  $('#logGrid').classList.toggle('single',solo||visiting);
  $('#logGrid').classList.toggle('hidden',solo&&visiting);
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
    if(t.invite_code)bits.push(`code: <b>${esc(t.invite_code)}</b> <button type="button" class="ghost" data-copylink="${esc(t.invite_code)}" title="Copy a link that joins this team">Copy invite link</button>`);
    return `<div class="listrow"><div class="leader-name">${avatarHtml(t.image_url,t.name,'logo-sm')}<div><b>${esc(t.name)}</b><div class="muted">${bits.join(' · ')}</div></div></div><div class="btnrow">${actions.join('')}</div></div>`;
  }).join('')||'<p class="muted">No teams yet — create the first one.</p>';
  $all('[data-copylink]').forEach(b=>b.onclick=()=>copyInviteLink(b.dataset.copylink,b));
  $all('[data-jointeam]').forEach(b=>b.onclick=async()=>{await api(`/api/teams/${b.dataset.jointeam}/join`,{method:'POST'});await refreshChallenge()});
  $all('[data-manageteam]').forEach(b=>b.onclick=()=>openTeamManage(Number(b.dataset.manageteam),b.dataset.name));
  $('#teamLeaderboard').innerHTML=curLeaderboard.teams.map((t,i)=>`<div class="leader"><span class="rank">${i+1}</span><span class="leader-name">${avatarHtml(t.image_url,t.name,'logo-sm')}<b>${esc(t.name)}</b></span><span>${esc(fmtTotal(c,t.minutes,t.distance))}</span></div>`).join('')||'<p class="muted">No teams yet.</p>';
  $('#userLeaderboard').innerHTML=curLeaderboard.users.map((x,i)=>`<div class="leader"><span class="rank">${i+1}</span><span class="leader-name">${avatarHtml(x.avatar_url,x.name,'avatar-sm')}<b>${esc(x.name)}</b></span><span>${esc(fmtTotal(c,x.minutes,x.distance))}</span></div>`).join('')||'<p class="muted">No members yet.</p>';
  const recent=dash.mine.filter(a=>a.challenge_id===c.id);
  $('#recent').innerHTML=recent.map(x=>{
    const timeBit=x.start_time&&x.end_time?` · ${x.start_time}–${x.end_time}`:'';
    const commentBit=x.comment?`<div class="muted">“${esc(x.comment)}”</div>`:'';
    return `<div class="listrow"><div><b>${esc(x.activity_type)}</b><div class="muted">${x.team_name?`${esc(x.team_name)} · `:''}${x.activity_date}${timeBit} · ${x.source}</div>${commentBit}</div><div class="btnrow"><b>${esc(fmtEntry(c,x))}</b>${x.has_route?`<button class="ghost" data-maproute="${x.id}">Map</button>`:''}<button class="ghost" data-editactivity="${x.id}">Edit</button><button class="ghost" data-delactivity="${x.id}">Delete</button></div></div>`;
  }).join('')||'<p class="muted">No activity logged yet in this challenge.</p>';
  $all('[data-editactivity]').forEach(b=>{const x=recent.find(a=>a.id===Number(b.dataset.editactivity));b.onclick=()=>openEditActivity(x)});
  $all('[data-maproute]').forEach(b=>{const x=recent.find(a=>a.id===Number(b.dataset.maproute));b.onclick=()=>openRouteMap(x)});
  $all('[data-delactivity]').forEach(b=>b.onclick=async()=>{
    if(!confirm('Delete this activity entry?'))return;
    try{await api(`/api/activities/${b.dataset.delactivity}`,{method:'DELETE'});await refreshChallenge()}catch(e){alert(e.message)}
  });
}

async function openEditChallenge(c,after=refreshChallenge){
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
      await after();
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
      if(after===refreshChallenge&&challengeBack!=='admin')showHome();else showAdmin();
    }catch(x){$('#deleteChallengeMsg').textContent=x.message}
  };
  $('#addOwnerForm').onsubmit=async e=>{
    e.preventDefault();
    try{await api(`/api/challenges/${c.id}/owners`,{method:'POST',body:JSON.stringify({email:$('#addOwnerEmail').value})});await openEditChallenge(c,after)}catch(x){$('#ownerMsg').textContent=x.message}
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

// --- Administration (global admins) ---------------------------------------------------------
let challengeBack='home',adminTab='users',adminUsers=[],adminChallenges=[];
const MEASURE_LABEL=c=>c.metric==='distance'?`Distance (${c.distance_unit==='km'?'km':'miles'})`:'Active minutes';
const STATE_LABEL={running:'Running',upcoming:'Not started',finished:'Finished'};
const plural=(n,one,many)=>`${n} ${n===1?one:many}`;
async function showAdmin(){
  if(me.role!=='global_admin')return showHome();
  showView('#adminView');
  await renderAdmin();
}
function setAdminTab(t){
  adminTab=t;
  setUrl(t==='challenges'?'/admin/challenges':'/admin',true);
  $all('[data-admintab]').forEach(b=>b.classList.toggle('active',b.dataset.admintab===t));
  $('#adminUsers').classList.toggle('hidden',t!=='users');
  $('#adminChallenges').classList.toggle('hidden',t!=='challenges');
}
async function renderAdmin(){
  setAdminTab(adminTab);
  try{
    const [u,c]=await Promise.all([api('/api/admin/users'),api('/api/admin/challenges')]);
    adminUsers=u.users;adminChallenges=c.challenges;
  }catch(e){$('#adminUserList').innerHTML=$('#adminChallengeList').innerHTML=`<p class="error">${esc(e.message)}</p>`;return}
  renderAdminUsers();renderAdminChallenges();
}
function renderAdminUsers(){
  const q=$('#adminUserSearch').value.trim().toLowerCase();
  const rows=adminUsers.filter(x=>!q||`${x.name} ${x.email}`.toLowerCase().includes(q));
  $('#adminUserCount').textContent=q?`${rows.length} of ${adminUsers.length}`:String(adminUsers.length);
  $('#adminUserList').innerHTML=rows.map(x=>`<div class="adminrow"><div><div class="leader-name">${avatarHtml(x.avatar_url,x.name,'avatar-sm')}<b>${esc(x.name)}</b>${x.id===me.id?' <span class="muted">(you)</span>':''}</div>
    <div class="facts"><span>${esc(x.email)}</span><span>${plural(x.challenges,'challenge','challenges')}</span><span>${plural(x.activities,'activity','activities')}</span><span>${x.last_activity?`last active ${esc(x.last_activity)}`:'no activity yet'}</span>${x.tickets?`<span>${plural(x.tickets,'ticket','tickets')}</span>`:''}<span>joined ${esc(String(x.created_at||'').slice(0,10))}</span></div></div>
    <div class="btnrow">${x.deactivated_at?statusPillFor('deactivated','Deactivated'):''}${statusPillFor(x.role,x.role==='global_admin'?'Global admin':'Member')}<button class="ghost" data-edituser="${x.id}">Edit</button></div></div>`).join('')||'<p class="muted">No users match.</p>';
  $all('[data-edituser]').forEach(b=>{const x=adminUsers.find(x2=>x2.id===Number(b.dataset.edituser));b.onclick=()=>openEditUser(x)});
}
function renderAdminChallenges(){
  const q=$('#adminChallengeSearch').value.trim().toLowerCase(),st=$('#adminChallengeState').value;
  const rows=adminChallenges.filter(c=>(!st||c.state===st)&&(!q||`${c.name} ${c.owners||''} ${c.creator_name||''} ${c.invite_code}`.toLowerCase().includes(q)));
  $('#adminChallengeCount').textContent=rows.length===adminChallenges.length?String(rows.length):`${rows.length} of ${adminChallenges.length}`;
  $('#adminChallengeList').innerHTML=rows.map(c=>`<div class="adminrow"><div><b>${esc(c.name)}</b>
    <div class="facts"><span>${esc(c.start_date)} → ${esc(c.end_date)}</span><span>${esc(MEASURE_LABEL(c))}</span><span>${c.participation==='individual'?'Individuals':plural(c.teams,'team','teams')}</span><span>${plural(c.members,'member','members')}</span><span>${plural(c.activities,'activity','activities')}</span><span>owner: ${esc(c.owners||c.creator_name||'none')}</span><span>code ${esc(c.invite_code)}</span>${c.state==='finished'?`<span title="Finished challenges and their activity are deleted 60 days after they end">deleted on ${esc(c.purge_date)}</span>`:''}</div></div>
    <div class="btnrow">${statusPillFor(c.state,STATE_LABEL[c.state])}<button data-adminopen="${c.id}">Open</button><button class="ghost" data-adminedit="${c.id}">Edit</button></div></div>`).join('')||'<p class="muted">No challenges match.</p>';
  $all('[data-adminopen]').forEach(b=>b.onclick=()=>{challengeBack='admin';openChallenge(Number(b.dataset.adminopen)).catch(e=>alert(e.message))});
  $all('[data-adminedit]').forEach(b=>b.onclick=async()=>{
    try{const c=await api(`/api/challenges/${b.dataset.adminedit}`);challengeBack='admin';await openEditChallenge(c,async()=>{await loadDashboard();await renderAdmin()})}catch(e){alert(e.message)}
  });
}
const statusPillFor=(cls,label)=>`<span class="status ${esc(cls)}">${esc(label)}</span>`;
$('#adminBtn').onclick=()=>showAdmin();
$('#adminBack').onclick=()=>showHome();
$('#adminSupport').onclick=()=>showHelp();
$all('[data-admintab]').forEach(b=>b.onclick=()=>setAdminTab(b.dataset.admintab));
$('#adminUserSearch').oninput=renderAdminUsers;
$('#adminChallengeSearch').oninput=renderAdminChallenges;
$('#adminChallengeState').onchange=renderAdminChallenges;
$('#adminNewUserBtn').onclick=()=>{$('#newUser').classList.toggle('hidden');if(!$('#newUser').classList.contains('hidden'))$('#newUser [name=name]').focus()};
$('#newUser').onsubmit=async e=>{
  e.preventDefault();
  try{await api('/api/admin/users',{method:'POST',body:JSON.stringify(Object.fromEntries(new FormData(e.target)))});e.target.reset();e.target.classList.add('hidden');$('#newUserMsg').textContent='';await renderAdmin()}
  catch(x){$('#newUserMsg').textContent=x.message}
};

function openEditUser(x){
  $('#modalBody').innerHTML=`<h2>Edit ${esc(x.name)}</h2>
    <form id="editUserForm">
      <label>Name<input id="euName" value="${esc(x.name)}" required></label>
      <label>Email<input id="euEmail" type="email" value="${esc(x.email)}" required></label>
      <label>Role<select id="euRole"><option value="member"${x.role==='member'?' selected':''}>Member</option><option value="global_admin"${x.role==='global_admin'?' selected':''}>Global admin</option></select></label>
      <label>Reset password (leave blank to keep current)<input id="euPassword" type="password" minlength="8"></label>
      <button>Save changes</button>
    </form>
    <p id="euMsg" class="error"></p>
    ${x.id===me.id?'':`<div class="danger-zone"><h2>${x.deactivated_at?'Deactivated':'Deactivate or delete'}</h2>
      <p class="muted">${x.deactivated_at?`Deactivated ${esc(String(x.deactivated_at).slice(0,10))}. They can't sign in; their activity still counts.`:'Deactivating signs them out everywhere and stops them signing in. Their activity stays on the leaderboards, and you can reactivate them at any time.'}</p>
      <div class="btnrow"><button type="button" class="${x.deactivated_at?'secondary':'danger'}" id="euActive">${x.deactivated_at?'Reactivate account':'Deactivate account'}</button><button type="button" class="danger" id="euDelete">Delete account</button></div>
      <p class="muted">Deleting removes the account with all their activity, routes, team memberships and tickets, for good. Challenges and teams they created stay, credited to you.</p></div>`}`;
  $('#modal').showModal();
  if($('#euActive'))$('#euActive').onclick=async()=>{
    if(!x.deactivated_at&&!confirm(`Deactivate ${x.name}? They'll be signed out and can't sign in until reactivated.`))return;
    try{await api(`/api/admin/users/${x.id}`,{method:'PATCH',body:JSON.stringify({active:!!x.deactivated_at})});$('#modal').close();renderAdmin()}catch(err){$('#euMsg').textContent=err.message}
  };
  if($('#euDelete'))$('#euDelete').onclick=async()=>{
    const typed=prompt(`This permanently deletes ${x.name} (${x.email}) and everything they logged. Type their email to confirm.`);
    if(typed===null)return;
    if(typed.trim().toLowerCase()!==x.email.toLowerCase()){$('#euMsg').textContent='The email did not match, so nothing was deleted.';return}
    try{await api(`/api/admin/users/${x.id}`,{method:'DELETE'});$('#modal').close();renderAdmin()}catch(err){$('#euMsg').textContent=err.message}
  };
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
      <label>About me (optional)<input id="acctBio" maxlength="280" value="${esc(me.bio||'')}" placeholder="A line for your profile"></label>
      <label>Profile sharing<select id="acctSharing">
        <option value="private"${me.profile_sharing==='private'?' selected':''}>Private - name and photo only</option>
        <option value="summary"${!me.profile_sharing||me.profile_sharing==='summary'?' selected':''}>Totals - plus my total and rank in each shared challenge</option>
        <option value="full"${me.profile_sharing==='full'?' selected':''}>Full - plus my recent activity in shared challenges</option>
      </select></label>
      <p class="muted">Only people in a challenge with you can see your profile, and only for challenges you share. Leaderboard totals are always visible to them; GPS routes never are.</p>
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
    const payload={name:$('#acctName').value.trim(),email:$('#acctEmail').value.trim(),bio:$('#acctBio').value,profileSharing:$('#acctSharing').value};
    // Only send email when it changed - sending it at all asks for the current password.
    if(payload.email.toLowerCase()===String(me.email).toLowerCase())delete payload.email;
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
// --- Help & support ------------------------------------------------------------------------
const TICKET_TYPE_LABEL={bug:'Bug',feature:'Feature request',question:'Question'};
const TICKET_STATUS_LABEL={new:'New',in_progress:'In progress',planned:'Planned',done:'Done',declined:'Declined'};
const statusPill=s=>`<span class="status ${esc(s)}">${esc(TICKET_STATUS_LABEL[s]||s)}</span>`;
const fmtWhen=s=>{const d=new Date(String(s||'').replace(' ','T')+'Z');return isNaN(d)?'':d.toLocaleString(undefined,{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'})};
let dashFilter={status:'open',type:''};
function showHelp(){
  setUrl('/help');
  showView('#helpView');
  $('#supportDashboard').classList.toggle('hidden',me.role!=='global_admin');
  renderHelp();
}
async function refreshHelpBadge(){
  try{
    const b=await api('/api/tickets/badge'),n=b.mine+(me.role==='global_admin'?b.admin:0);
    $('#helpBadge').textContent=n;$('#helpBadge').classList.toggle('hidden',!n);
    $('#helpBadge').title=me.role==='global_admin'?`${b.mine} repl${b.mine===1?'y':'ies'} to you, ${b.admin} ticket(s) needing support`:`${n} new repl${n===1?'y':'ies'}`;
  }catch(e){}
}
function ticketRow(t,showReporter){
  return `<div class="listrow ticketrow" data-ticket="${t.id}"><div><b>${t.unread?'<span class="unread-dot" title="New"></span>':''}${esc(t.title)}</b><div class="muted">${esc(TICKET_TYPE_LABEL[t.type]||t.type)} · #${t.id}${showReporter?` · ${esc(t.reporter.name)}`:''} · updated ${esc(fmtWhen(t.updated_at))}${t.comment_count?` · ${t.comment_count} repl${t.comment_count===1?'y':'ies'}`:''}</div></div><div>${statusPill(t.status)}</div></div>`;
}
async function renderHelp(){
  try{
    const mine=await api('/api/tickets');
    $('#myTickets').innerHTML=mine.tickets.map(t=>ticketRow(t,false)).join('')||'<p class="muted">You haven\'t sent any tickets yet.</p>';
    if(me.role==='global_admin'){
      const q=new URLSearchParams({scope:'all'});if(dashFilter.status)q.set('status',dashFilter.status);if(dashFilter.type)q.set('type',dashFilter.type);
      const all=await api('/api/tickets?'+q);
      $('#ticketCounts').innerHTML=Object.entries(all.counts).map(([s,n])=>`<button type="button" data-dashstatus="${s}" class="${dashFilter.status===s?'on':''}">${esc(TICKET_STATUS_LABEL[s])} · ${n}</button>`).join('')+
        `<span class="muted" style="align-self:center">Open: ${all.byType.bug} bug(s), ${all.byType.feature} idea(s), ${all.byType.question} question(s)</span>`;
      $('#dashTickets').innerHTML=all.tickets.map(t=>ticketRow(t,true)).join('')||'<p class="muted">No tickets match.</p>';
      $all('[data-dashstatus]').forEach(b=>b.onclick=()=>{dashFilter.status=b.dataset.dashstatus;$('#dashStatus').value=dashFilter.status;renderHelp()});
    }
    $all('[data-ticket]').forEach(r=>r.onclick=()=>openTicket(Number(r.dataset.ticket)));
  }catch(e){$('#myTickets').innerHTML=`<p class="error">${esc(e.message)}</p>`}
  refreshHelpBadge();
}
async function openTicket(id){
  const t=await api(`/api/tickets/${id}`),admin=me.role==='global_admin';
  if(location.pathname.startsWith('/help'))setUrl(`/help/tickets/${id}`);
  const convo=t.comments.map(c=>`<div class="bubble ${c.internal?'internal':c.from_support?'support':''}"><div class="who">${esc(c.author.name)}${c.from_support?' · Support':''}${c.internal?' · internal note (only admins see this)':''} · ${esc(fmtWhen(c.created_at))}</div>${esc(c.body).replace(/\n/g,'<br>')}</div>`).join('');
  $('#modalBody').innerHTML=`<h2>${esc(t.title)}</h2>
    <p>${statusPill(t.status)} <span class="muted">${esc(TICKET_TYPE_LABEL[t.type])} · #${t.id} · ${t.mine?'you':esc(t.reporter.name)+(t.reporter.email?` (${esc(t.reporter.email)})`:'')} · ${esc(fmtWhen(t.created_at))}</span></p>
    <p style="white-space:pre-wrap">${esc(t.description)}</p>
    ${t.image_url?`<a href="${esc(t.image_url)}" target="_blank" rel="noopener"><img class="ticket-img" src="${esc(t.image_url)}" alt="Screenshot"></a>`:''}
    ${t.client_info?`<p class="muted">Device: ${esc(t.client_info)}</p>`:''}
    ${t.resolution?`<div class="outcome"><b>Outcome:</b> ${esc(t.resolution).replace(/\n/g,'<br>')}</div>`:''}
    ${admin?`<form id="ticketAdminForm" class="card" style="padding:14px;margin:12px 0"><div class="two"><label>Status<select id="taStatus">${Object.entries(TICKET_STATUS_LABEL).map(([k,v])=>`<option value="${k}"${t.status===k?' selected':''}>${v}</option>`).join('')}</select></label><div></div></div><label>Outcome the reporter sees<textarea id="taResolution" rows="2" maxlength="2000">${esc(t.resolution||'')}</textarea></label><button>Update status</button></form>`:''}
    <h2 style="margin-top:18px">Conversation</h2><div class="convo">${convo||'<p class="muted">No replies yet.</p>'}</div>
    <form id="ticketReplyForm"><label>${admin&&!t.mine?'Reply to the reporter':'Add a reply'}<textarea id="trBody" rows="3" maxlength="5000" required></textarea></label>${admin?'<label style="display:flex;gap:8px;align-items:center"><input type="checkbox" id="trInternal" style="width:auto;margin:0"> Internal note (not shown to the reporter)</label>':''}<button>Send reply</button></form>
    <p id="ticketModalMsg" class="error"></p>`;
  $('#modal').showModal();
  $('#ticketReplyForm').onsubmit=async e=>{e.preventDefault();try{await api(`/api/tickets/${id}/comments`,{method:'POST',body:JSON.stringify({body:$('#trBody').value,internal:!!($('#trInternal')&&$('#trInternal').checked)})});await openTicket(id);renderHelp()}catch(x){$('#ticketModalMsg').textContent=x.message}};
  if(admin)$('#ticketAdminForm').onsubmit=async e=>{e.preventDefault();try{await api(`/api/tickets/${id}`,{method:'PATCH',body:JSON.stringify({status:$('#taStatus').value,resolution:$('#taResolution').value})});await openTicket(id);renderHelp()}catch(x){$('#ticketModalMsg').textContent=x.message}};
  refreshHelpBadge();
}
$('#helpBtn').onclick=showHelp;
$('#helpBack').onclick=()=>showHome();
$('#dashStatus').onchange=()=>{dashFilter.status=$('#dashStatus').value;renderHelp()};
$('#dashType').onchange=()=>{dashFilter.type=$('#dashType').value;renderHelp()};
$('#ticketForm').onsubmit=async e=>{
  e.preventDefault();
  const file=$('#ticketImage').files[0];
  try{
    const payload={type:$('#ticketType').value,title:$('#ticketTitle').value,description:$('#ticketDesc').value,client_info:`Web · ${navigator.userAgent.slice(0,200)}`};
    if(file)payload.image_url=await uploadImageFile(file,1600,0.85);
    const r=await api('/api/tickets',{method:'POST',body:JSON.stringify(payload)});
    e.target.reset();
    $('#ticketMsg').textContent=`Thanks - ticket #${r.id} sent. Replies will appear under My tickets.`;
    renderHelp();
  }catch(x){$('#ticketMsg').textContent=x.message}
};
setInterval(()=>{if(me)refreshHelpBadge()},120000);


$('#logout').onclick=async()=>{await api('/api/logout',{method:'POST'});location.reload()};
$('#backHome').onclick=()=>challengeBack==='admin'?showAdmin():showHome();
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
    // A minutes challenge has no distance box, so a GPX file's distance goes along as extra detail.
    const dist=isDistance(curChallenge)?{distance:$('#distance').value,distance_unit:$('#distanceUnit').value}:(pendingRoute&&pendingRoute.meters?{distance_m:pendingRoute.meters}:{});
    await api('/api/activities',{method:'POST',body:JSON.stringify({...(solo?{}:{team_id:teamId}),challenge_id:curChallenge.id,activity_type:$('#activityType').value,minutes:$('#minutes').value,...dist,activity_date:$('#activityDate').value,start_time:$('#startTime').value,end_time:$('#endTime').value,comment:$('#activityComment').value,...(pendingRoute?{route:pendingRoute.points}:{})})});
    pendingRoute=null;$('#gpxInfo').classList.add('hidden');
    $('#activityMsg').textContent='';
    const keepUnit=$('#distanceUnit').value;
    e.target.reset();
    $('#distanceUnit').value=keepUnit;
    $('#activityDate').value=new Date().toISOString().slice(0,10);
    await refreshChallenge();
  }catch(x){$('#activityMsg').textContent=x.message}
};
// --- GPX routes: read in the browser, so only the points (not the file) are uploaded -------------
let pendingRoute=null;
const R_EARTH=6371008.8;
function haversine(a,b){const r=Math.PI/180,dLat=(b[0]-a[0])*r,dLon=(b[1]-a[1])*r,h=Math.sin(dLat/2)**2+Math.cos(a[0]*r)*Math.cos(b[0]*r)*Math.sin(dLon/2)**2;return 2*R_EARTH*Math.asin(Math.sqrt(h))}
function routeMeters(pts){let m=0;for(let i=1;i<pts.length;i++)m+=haversine(pts[i-1],pts[i]);return m}
function parseGpx(text){
  const doc=new DOMParser().parseFromString(text,'application/xml');
  if(doc.querySelector('parsererror'))throw Error('That file is not valid GPX');
  // Track points first; a route-only file (rtept) is accepted too.
  let nodes=[...doc.getElementsByTagName('trkpt')];
  if(!nodes.length)nodes=[...doc.getElementsByTagName('rtept')];
  const pts=nodes.map(n=>{
    const t=n.getElementsByTagName('time')[0],e=n.getElementsByTagName('ele')[0];
    const ms=t?Date.parse(t.textContent):NaN;
    return [Number(n.getAttribute('lat')),Number(n.getAttribute('lon')),Number.isFinite(ms)?ms:null,e?Number(e.textContent):null];
  }).filter(p=>Number.isFinite(p[0])&&Number.isFinite(p[1]));
  if(pts.length<2)throw Error('No track points found in that GPX file');
  return pts;
}
const pad2=n=>String(n).padStart(2,'0');
$('#gpxFile').addEventListener('change',async()=>{
  const f=$('#gpxFile').files[0];
  pendingRoute=null;$('#gpxInfo').classList.add('hidden');
  if(!f)return;
  try{
    const pts=parseGpx(await f.text()),meters=routeMeters(pts);
    pendingRoute={points:pts,meters};
    // Fill whatever the person has left empty from the track itself.
    const times=pts.map(p=>p[2]).filter(t=>t!=null);
    if(times.length>1){
      const s=new Date(times[0]),e=new Date(times[times.length-1]);
      if(!$('#startTime').value)$('#startTime').value=`${pad2(s.getHours())}:${pad2(s.getMinutes())}`;
      if(!$('#endTime').value&&e.toDateString()===s.toDateString())$('#endTime').value=`${pad2(e.getHours())}:${pad2(e.getMinutes())}`;
      if(!$('#minutes').value)$('#minutes').value=Math.max(1,Math.round((times[times.length-1]-times[0])/60000));
      $('#activityDate').value=`${s.getFullYear()}-${pad2(s.getMonth()+1)}-${pad2(s.getDate())}`;
    }
    if(isDistance(curChallenge)&&!$('#distance').value)$('#distance').value=(meters/($('#distanceUnit').value==='km'?1000:1609.344)).toFixed(2);
    $('#gpxInfo').textContent=`Route loaded: ${pts.length} points, ${(meters/1000).toFixed(2)} km (${(meters/1609.344).toFixed(2)} mi). Only you can see your route.`;
    $('#gpxInfo').classList.remove('hidden');
  }catch(err){$('#gpxInfo').textContent=err.message;$('#gpxInfo').classList.remove('hidden');$('#gpxFile').value=''}
});
// Leaflet (OpenStreetMap tiles) is loaded only the first time a map is opened.
let leafletReady=null;
function loadLeaflet(){
  if(leafletReady)return leafletReady;
  leafletReady=new Promise((resolve,reject)=>{
    const css=document.createElement('link');css.rel='stylesheet';css.href='https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';document.head.appendChild(css);
    const js=document.createElement('script');js.src='https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';js.onload=()=>resolve(window.L);js.onerror=()=>{leafletReady=null;reject(Error('Could not load the map library'))};document.head.appendChild(js);
  });
  return leafletReady;
}
// Everything I've logged, across every challenge, newest first - with a map where a route exists.
let myActivity=[],myActivityMore=false;
async function loadMyActivity(append=false){
  const r=await api(`/api/me/activities?limit=20&offset=${append?myActivity.length:0}`);
  myActivity=append?myActivity.concat(r.activities):r.activities;myActivityMore=r.more;
  $('#myActivity').innerHTML=myActivity.map(x=>{
    const c={metric:x.metric,distance_unit:x.distance_unit};
    return `<div class="listrow"><div><b>${esc(x.activity_type)}</b><div class="muted">${esc(x.challenge_name)}${x.team_name?` · ${esc(x.team_name)}`:''} · ${x.activity_date}${x.start_time?` · ${x.start_time}`:''}</div></div><div class="btnrow"><b>${esc(fmtEntry(c,x))}</b>${x.has_route?`<button class="ghost" data-mymap="${x.id}">Map</button>`:''}</div></div>`;
  }).join('')||'<p class="muted">Nothing logged yet.</p>';
  $('#moreActivity').classList.toggle('hidden',!myActivityMore);
  $all('[data-mymap]').forEach(b=>{const x=myActivity.find(a=>a.id===Number(b.dataset.mymap));b.onclick=()=>openRouteMap(x,{metric:x.metric,distance_unit:x.distance_unit})});
}
$('#moreActivity').onclick=()=>loadMyActivity(true);
async function openRouteMap(x,cc=curChallenge){
  const dlg=$('#modal');
  $('#modalBody').innerHTML=`<h2>${esc(x.activity_type)}</h2><p class="muted">${x.activity_date}${x.start_time?` · ${x.start_time}–${x.end_time||''}`:''} · ${esc(fmtEntry(cc,x))}</p><div id="routeMap" class="route-map"></div><p class="muted">Only you can see this route.</p>`;
  dlg.classList.add('wide');
  dlg.addEventListener('close',()=>dlg.classList.remove('wide'),{once:true});
  dlg.showModal();
  try{
    const [L,r]=await Promise.all([loadLeaflet(),api(`/api/activities/${x.id}/route`)]);
    const line=r.points.map(p=>[p[0],p[1]]);
    const map=L.map('routeMap');
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19,attribution:'&copy; OpenStreetMap contributors'}).addTo(map);
    const poly=L.polyline(line,{color:'#d40511',weight:4}).addTo(map);
    L.circleMarker(line[0],{radius:6,color:'#1a7f37',fillOpacity:1}).addTo(map).bindTooltip('Start');
    L.circleMarker(line[line.length-1],{radius:6,color:'#171717',fillOpacity:1}).addTo(map).bindTooltip('Finish');
    map.fitBounds(poly.getBounds(),{padding:[20,20]});
  }catch(err){$('#routeMap').outerHTML=`<p class="error">${esc(err.message)}</p>`}
}
$('#health').onclick=()=>{$('#modalBody').innerHTML='<h2>Phone activity sync</h2><p><b>Android:</b> use the native companion app to read exercise sessions from Health Connect after the user grants permission.</p><p><b>iPhone:</b> use the native iOS companion app to read workouts from Apple Health through HealthKit.</p><p>This web app already includes the authenticated <code>/api/health/import</code> endpoint and duplicate protection. Native projects, store declarations and explicit user consent are still required.</p>';$('#modal').showModal()};

load();

// --- page addresses ----------------------------------------------------------------------------
// /                         home              /help, /help/tickets/5   help, a ticket over it
// /challenges/12            a challenge       /admin, /admin/challenges  global admins
// /join/CODE                an invite link: sign in or register, then confirm joining
// While route() is acting on an address it only replaces it, so following a link adds one history entry, not several.
let routing=false;
function setUrl(path,replace){if(location.pathname!==path)history[replace||routing?'replaceState':'pushState']({},'',path)}
const inviteUrl=code=>`${location.origin}/join/${encodeURIComponent(code)}`;
const inviteCodeFromPath=()=>{const m=location.pathname.match(/^\/join\/([A-Za-z0-9]+)\/?$/);return m?m[1].toUpperCase():null};
async function route(){
  const p=location.pathname;let m;
  routing=true;
  try{
    if((m=p.match(/^\/challenges\/(\d+)\/?$/)))return await openChallenge(Number(m[1]));
    if((m=p.match(/^\/help\/tickets\/(\d+)\/?$/))){showHelp();setUrl(p,true);return await openTicket(Number(m[1]))}
    if(/^\/help\/?$/.test(p))return showHelp();
    if((m=p.match(/^\/admin(\/challenges)?\/?$/))&&me.role==='global_admin'){adminTab=m[1]?'challenges':'users';return await showAdmin()}
    const code=inviteCodeFromPath();
    if(code)return await openJoinPrompt(code);
    showHome();
  }catch(e){alert(e.message);showHome()}
  finally{routing=false}
}
window.addEventListener('popstate',()=>{if(me){if($('#modal').open)$('#modal').close();route()}});
$('#modal').addEventListener('close',()=>{const m=location.pathname.match(/^\/help\/tickets\//);if(m)setUrl('/help',true)});

async function copyInviteLink(code,btn){
  const url=inviteUrl(code);
  try{await navigator.clipboard.writeText(url);const was=btn.textContent;btn.textContent='Link copied';setTimeout(()=>btn.textContent=was,1800)}
  catch(e){prompt('Copy this invite link:',url)}
}
// On an Android phone without the app's link handling (or before installing it), offer to open the invite in the app.
const isAndroid=/Android/i.test(navigator.userAgent);
const appInviteLink=code=>`intent://join/${encodeURIComponent(code)}#Intent;scheme=activetogether;package=com.activetogether.companion;end`;
function inviteSummary(pv){
  const c=pv.challenge,what=c.metric==='distance'?`distance (${c.distance_unit==='km'?'km':'miles'})`:'active minutes';
  const name=pv.team?`the team <b>${esc(pv.team.name)}</b> in <b>${esc(c.name)}</b>`:`<b>${esc(c.name)}</b>`;
  return {name,detail:`${esc(c.start_date)} → ${esc(c.end_date)} · measures ${what} · ${c.participation==='individual'?'individuals':'teams'} · ${c.members} member${c.members===1?'':'s'}`};
}
// Signed out on an invite link: say what it's for above the sign-in / register form.
async function showInviteBanner(){
  const code=inviteCodeFromPath(),el=$('#inviteBanner');
  if(!code){el.classList.add('hidden');return}
  try{
    const pv=await api(`/api/join/preview?code=${encodeURIComponent(code)}`),s=inviteSummary(pv);
    el.innerHTML=`<h2>You're invited</h2><p>Join ${s.name}.</p><p class="muted">${s.detail}</p><p>Sign in, or create an account if you're new, and we'll ask you to confirm joining.</p>${isAndroid?`<p><a class="ghost" href="${appInviteLink(code)}">Have the Android app? Open this invite in the app</a></p>`:''}`;
  }catch(e){el.innerHTML=`<h2>Invite link</h2><p class="error">${esc(e.message)}</p><p class="muted">Ask whoever sent it for a new link or code.</p>`}
  el.classList.remove('hidden');
}
// Signed in on an invite link: confirm before joining.
async function openJoinPrompt(code){
  let pv;
  try{pv=await api(`/api/join/preview?code=${encodeURIComponent(code)}`)}catch(e){showHome();alert(e.message);return}
  showHome();setUrl(`/join/${code}`,true);
  const s=inviteSummary(pv),done=pv.member&&(pv.type==='challenge'||pv.inTeam);
  s.name=s.name.replace(/^the team/,'Team');
  $('#modalBody').innerHTML=done
    ?`<h2>You're already in</h2><div class="invite-card"><p>${s.name}</p><p class="muted">${s.detail}</p></div><div class="btnrow"><button id="jpOpen">Open the challenge</button></div>`
    :`<h2>Join ${pv.team?'this team':'this challenge'}?</h2><div class="invite-card"><p>${s.name}</p><p class="muted">${s.detail}</p></div>
      ${pv.member&&pv.team?'<p class="muted">You\'re already in the challenge; this adds you to the team.</p>':''}
      <div class="btnrow"><button id="jpJoin">Join</button><button type="button" class="ghost" id="jpCancel">Not now</button></div><p id="jpMsg" class="error"></p>`;
  $('#modal').showModal();
  const leave=()=>{$('#modal').close();if(location.pathname.startsWith('/join/'))setUrl('/',true)};
  if(done){$('#jpOpen').onclick=()=>{$('#modal').close();openChallenge(pv.challenge.id)};return}
  $('#jpCancel').onclick=leave;
  $('#jpJoin').onclick=async()=>{
    try{const r=await api('/api/join',{method:'POST',body:JSON.stringify({code})});$('#modal').close();await loadDashboard();await openChallenge(r.challengeId)}
    catch(e){$('#jpMsg').textContent=e.message}
  };
}
