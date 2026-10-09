const $=s=>document.querySelector(s), $all=s=>[...document.querySelectorAll(s)];
const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
// The site's own alert / confirm / prompt, on a dialog of their own so they can sit over the main one.
// They resolve to: nothing (alert), true or false (confirm), the text or null (prompt).
function ask({title='',message='',ok='OK',cancel='Cancel',danger=false,input=null}){
  return new Promise(resolve=>{
    const dlg=$('#ask');let done=false;
    const finish=v=>{if(done)return;done=true;if(dlg.open)dlg.close();resolve(v)};
    $('#askBody').innerHTML=`${title?`<h2>${esc(title)}</h2>`:''}<p class="ask-text">${esc(message)}</p>${input?`<input id="askInput" value="${esc(input.value||'')}" placeholder="${esc(input.placeholder||'')}"${input.readonly?' readonly':''} autocomplete="off">`:''}
      <div class="btnrow ask-actions">${cancel?`<button type="button" class="ghost" data-ask="no">${esc(cancel)}</button>`:''}<button type="button" class="${danger?'danger':''}" data-ask="yes">${esc(ok)}</button></div>`;
    const yes=()=>finish(input?(input.readonly?true:$('#askInput').value):true),no=()=>finish(input?null:false);
    $('#askBody [data-ask="yes"]').onclick=yes;
    if(cancel)$('#askBody [data-ask="no"]').onclick=no;
    dlg.onclose=()=>finish(input?null:cancel?false:undefined);
    dlg.showModal();
    if(input){const i=$('#askInput');i.focus();i.select();i.onkeydown=e=>{if(e.key==='Enter'){e.preventDefault();yes()}}}
    else $('#askBody [data-ask="yes"]').focus();
  });
}
const uiAlert=(message,title)=>ask({message,title,cancel:null});
const uiConfirm=(message,opt={})=>ask({message,ok:'OK',...opt});
const uiPrompt=(message,opt={})=>ask({message,ok:opt.ok||'OK',title:opt.title,input:{value:opt.value,placeholder:opt.placeholder}});
// Something to copy, when the clipboard isn't available: shown selected, ready to copy by hand.
const uiCopy=(message,value)=>ask({message,ok:'Done',cancel:null,input:{value,readonly:true}});
// Dates arrive as YYYY-MM-DD and show the way the apps do: 1 Oct 2026, 1 Oct – 31 Dec 2026, Thu 8 Oct.
// Today on this device, as YYYY-MM-DD (toISOString would give the UTC date, a day out late in the evening or after midnight).
const localToday=()=>{const d=new Date();return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`};
const isoDate=s=>/^\d{4}-\d{2}-\d{2}$/.test(String(s||''))?new Date(s+'T00:00:00'):null;
const fmtDate=s=>{const d=isoDate(s);return d?d.toLocaleDateString(undefined,{day:'numeric',month:'short',year:'numeric'}):String(s||'')};
function fmtRange(a,b){
  const x=isoDate(a),y=isoDate(b);if(!x||!y)return `${fmtDate(a)} – ${fmtDate(b)}`;
  return x.getFullYear()===y.getFullYear()?`${x.toLocaleDateString(undefined,{day:'numeric',month:'short'})} – ${fmtDate(b)}`:`${fmtDate(a)} – ${fmtDate(b)}`;
}
const fmtDay=s=>{const d=isoDate(s);if(!d)return String(s||'');return d.toLocaleDateString(undefined,{weekday:'short',day:'numeric',month:'short',...(d.getFullYear()!==new Date().getFullYear()?{year:'numeric'}:{})})};
// Where a challenge is in its run, as the apps say it.
function runLabel(c){
  const today=localToday(),day=864e5,diff=(a,b)=>Math.round((isoDate(b)-isoDate(a))/day);
  if(!isoDate(c.start_date)||!isoDate(c.end_date))return '';
  if(today<c.start_date){const n=diff(today,c.start_date);return n===1?'Starts tomorrow':`Starts in ${n} days`}
  if(today>c.end_date)return 'Finished';
  const n=diff(today,c.end_date);return n===0?'Last day':n===1?'1 day left':`${n} days left`;
}
const SOURCE_LABEL={manual:'logged by hand',health_connect:'Health Connect',health_kit:'Apple Health',shortcut:'Apple Shortcut'};
// Requests in flight: a thin bar along the top shows once anything takes longer than a moment.
let inFlight=0,barTimer=null;
const progress=d=>{inFlight+=d;const bar=document.getElementById('progressBar');if(!bar)return;
  if(inFlight>0&&!barTimer&&!bar.classList.contains('on'))barTimer=setTimeout(()=>{barTimer=null;if(inFlight>0)bar.classList.add('on')},180);
  if(inFlight===0){clearTimeout(barTimer);barTimer=null;bar.classList.remove('on')}};
// Errors carry the server's whole reply (e.data) and status, as well as its message.
const api=async(url,opt={})=>{progress(1);try{const r=await fetch(url,{headers:{'Content-Type':'application/json'},...opt});const j=await r.json().catch(()=>({}));if(!r.ok){const e=Error(j.error||'Request failed');e.data=j;e.status=r.status;throw e}return j}finally{progress(-1)}};
// Forms that save something: their buttons are disabled until the save finishes, so a double click (or a
// slow connection) never saves twice.
const guarded=fn=>async function(e){
  e.preventDefault();
  const f=e.currentTarget||e.target;if(f.dataset.busy)return;
  const buttons=[...f.querySelectorAll('button:not([type="button"])')];
  f.dataset.busy='1';buttons.forEach(b=>b.disabled=true);
  try{await fn.call(this,e)}finally{delete f.dataset.busy;buttons.forEach(b=>b.disabled=false)}
};

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
        // Remember where the cursor was: the prompt dialog takes the focus away from the editor.
        const sel=window.getSelection(),range=sel.rangeCount?sel.getRangeAt(0).cloneRange():null;
        const url=await uiPrompt('Link address',{placeholder:'https://...',ok:'Add link'});
        if(url){editor.focus();if(range){sel.removeAllRanges();sel.addRange(range)}document.execCommand('createLink',false,url)}
      }else if(cmd==='insertImage'){
        const input=document.createElement('input');
        input.type='file';input.accept='image/*';
        input.onchange=async()=>{
          const file=input.files[0];
          if(!file)return;
          try{const url=await uploadImageFile(file,900,0.82);editor.focus();document.execCommand('insertHTML',false,`<img src="${url}" alt="">`)}
          catch(e){uiAlert(e.message)}
        };
        input.click();
      }else{
        document.execCommand(cmd,false,null);
      }
    };
  });
}

let me=null, dash=null, curChallenge=null, curLeaderboard=null, authTab='login';

// --- what a challenge measures: active minutes (the default), distance in miles/km, or steps ---
const isDistance=c=>c&&c.metric==='distance';
// A step challenge counts a day's steps: one entry per day, no duration or distance.
const isSteps=c=>c&&c.metric==='steps';
// Individuals-only challenges have no teams: activity is logged straight to the challenge.
const isIndividual=c=>!!c&&c.participation==='individual';
const unitShort=c=>c&&c.distance_unit==='km'?'km':'mi';
const unitLong=c=>c&&c.distance_unit==='km'?'Kilometres':'Miles';
const fmtNum=n=>Number(n||0).toLocaleString(undefined,{maximumFractionDigits:2});
// The challenge's own measure, e.g. "12.4 mi", "340 min" or "84,200 steps".
function fmtTotal(c,minutes,distance,steps){return isSteps(c)?`${fmtNum(steps)} steps`:isDistance(c)?`${fmtNum(distance)} ${unitShort(c)}`:`${fmtNum(minutes)} min`}
// One activity: both figures when it has both, the challenge's measure first.
function fmtEntry(c,x){
  if(x.steps!=null&&(isSteps(c)||x.minutes==null&&x.distance==null))return `${fmtNum(x.steps)} steps`;
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
// The bot check on signing in, signing up and asking for a password reset: Cloudflare Turnstile (usually
// invisible) or Google reCAPTCHA, whichever the server is set up with, or none.
let captcha=null,captchaWidget=null,siteInviteOnly=false;
function renderCaptchaIfReady(){
  const el=document.getElementById('captcha-box');
  if(!el||!captcha)return;
  const ts=captcha.provider==='turnstile';
  if(ts?!window.turnstile:!(window.grecaptcha&&grecaptcha.render))return;
  if(ts&&captchaWidget!==null)try{turnstile.remove(captchaWidget)}catch(e){}
  el.innerHTML='';
  captchaWidget=ts?turnstile.render(el,{sitekey:captcha.siteKey,appearance:'interaction-only'}):grecaptcha.render(el,{sitekey:captcha.siteKey});
}
// Turnstile works in the background, so its answer may still be on its way: wait a few seconds for it.
async function captchaToken(){
  if(!captcha||captchaWidget===null)return '';
  if(captcha.provider!=='turnstile')return window.grecaptcha?grecaptcha.getResponse(captchaWidget):'';
  for(let i=0;i<25;i++){const t=window.turnstile&&turnstile.getResponse(captchaWidget);if(t)return t;await new Promise(r=>setTimeout(r,200))}
  return '';
}
function resetCaptcha(){if(!captcha||captchaWidget===null)return;try{captcha.provider==='turnstile'?turnstile.reset(captchaWidget):grecaptcha.reset(captchaWidget)}catch(e){}}
async function initCaptcha(){
  try{const cfg=await api('/api/config');captcha=cfg.captcha||null;siteInviteOnly=!!cfg.inviteOnly}catch(e){captcha=null}
  // The sign-up form depends on whether the site is invite only, which is only known now.
  if(!me&&authTab==='register'&&!$('#authSection').classList.contains('hidden'))renderAuth();
  if(!captcha)return;
  window.onCaptchaLoad=renderCaptchaIfReady;
  const s=document.createElement('script');
  s.src=captcha.provider==='turnstile'?'https://challenges.cloudflare.com/turnstile/v0/api.js?onload=onCaptchaLoad&render=explicit':'https://www.google.com/recaptcha/api.js?onload=onCaptchaLoad&render=explicit';
  s.async=true;
  document.head.appendChild(s);
}
initCaptcha();

async function load(){
  const m=await api('/api/me'); me=m.user;
  // Password pages work signed out (and a reset link works even when signed in, say on a shared computer).
  const pw=location.pathname.match(/^\/(?:forgot|reset\/([A-Za-z0-9_-]+))\/?$/);
  if(pw&&(pw[1]||!me)){showSignedOut();return showPasswordPage(pw[1]||null)}
  if(pw)setUrl('/',true);
  if(!me){showInviteBanner();showSignedOut();renderAuth();return}
  $('#authSection').classList.add('hidden');$('#app').classList.remove('hidden');$('#logout').classList.remove('hidden');$('#homeBtn').classList.remove('hidden');$('#myAccount').classList.remove('hidden');$('#myProfile').classList.remove('hidden');$('#menuToggle').classList.remove('hidden');$('#helpBtn').classList.remove('hidden');refreshHelpBadge();
  if(pendingInviteToken){try{await api('/api/invites/accept',{method:'POST',body:JSON.stringify({token:pendingInviteToken})})}catch(e){await uiAlert(e.message)}pendingInviteToken=null}
  await loadDashboard();
  $('#adminBtn').classList.toggle('hidden',me.role!=='global_admin');
  $('#inviteBanner').classList.add('hidden');
  await route();
}

function showSignedOut(){
  $('#authSection').classList.remove('hidden');$('#app').classList.add('hidden');
  for(const id of ['#logout','#myAccount','#myProfile','#homeBtn','#menuToggle','#helpBtn','#adminBtn'])$(id).classList.add('hidden');
}
// Forgot password (token null): ask for the email, or say how to get a link when the site doesn't send email.
// A reset link (/reset/TOKEN): choose a new password, then sign in with it.
async function showPasswordPage(token){
  $all('[data-authtab]').forEach(b=>b.classList.remove('active'));
  const back='<p><a href="/" data-signin>Back to sign in</a></p>';
  const wireBack=()=>$all('[data-signin]').forEach(a=>a.onclick=e=>{e.preventDefault();setUrl('/');authTab='login';renderAuth()});
  if(!token){
    let cfg={};try{cfg=await api('/api/config')}catch(e){}
    $('#authPanel').innerHTML=`<h1>Forgot your password?</h1>${cfg.passwordResetEmail
      ?`<p>Enter the email you signed up with and we'll send you a link to choose a new password.</p><form id="forgotForm"><label>Email<input id="fEmail" type="email" required autocomplete="email"></label><div id="captcha-box"></div><button>Send me a link</button></form>`
      :`<p>Ask for a reset link: email <a href="mailto:support@activetogether.team">support@activetogether.team</a> from the address you signed up with, or ask the person who runs your challenge to contact us. The link lets you choose a new password.</p>`}<p id="authMsg" class="error"></p>${back}`;
    wireBack();
    if($('#forgotForm')){
      renderCaptchaIfReady();
      $('#forgotForm').onsubmit=guarded(async()=>{
        try{await api('/api/password/forgot',{method:'POST',body:JSON.stringify({email:$('#fEmail').value,captchaToken:await captchaToken()})});
          $('#authPanel').innerHTML=`<h1>Check your email</h1><p>If an account uses that address, a link to choose a new password is on its way. It works for an hour. Nothing after a few minutes? Check your spam folder.</p>${back}`;wireBack()}
        catch(x){$('#authMsg').textContent=x.message;resetCaptcha()}
      });
    }
    return;
  }
  let who;
  try{who=await api(`/api/password/reset?token=${encodeURIComponent(token)}`)}
  catch(e){$('#authPanel').innerHTML=`<h1>Reset link</h1><p class="error">${esc(e.message)}</p><p><a href="/forgot" data-forgot>Ask for a new link</a></p>${back}`;wireBack();$('[data-forgot]').onclick=ev=>{ev.preventDefault();setUrl('/forgot');showPasswordPage(null)};return}
  $('#authPanel').innerHTML=`<h1>Choose a new password</h1><p>For ${esc(who.name)}'s account.</p><form id="resetForm"><label>New password<input id="rpNew" type="password" required minlength="8" autocomplete="new-password"></label><label>Type it again<input id="rpAgain" type="password" required minlength="8" autocomplete="new-password"></label><button>Save new password</button></form><p id="authMsg" class="error"></p>`;
  $('#resetForm').onsubmit=guarded(async()=>{
    if($('#rpNew').value!==$('#rpAgain').value){$('#authMsg').textContent="The two passwords don't match.";return}
    try{
      const r=await api('/api/password/reset',{method:'POST',body:JSON.stringify({token,password:$('#rpNew').value})});
      me=null;setUrl('/');authTab='login';showSignedOut();renderAuth();
      $('#email').value=r.email||'';$('#authMsg').className='muted';$('#authMsg').textContent='Password changed. Sign in with your new password.';$('#password').focus();
    }catch(x){$('#authMsg').textContent=x.message}
  });
}
// Two-step sign-in: after the password, the code from the authenticator app (or a backup code).
function showCodeStep(ticket,url){
  $('#authPanel').innerHTML=`<h1>Two-step sign-in</h1><p>Enter the 6-digit code from your authenticator app, or one of your backup codes.</p><form id="codeForm"><label>Code<input id="tfCode" required autocomplete="one-time-code" inputmode="numeric" maxlength="12" spellcheck="false"></label><button>Sign in</button></form><p id="authMsg" class="error"></p><p><a href="/" data-signin>Start again</a></p>`;
  $('[data-signin]').onclick=e=>{e.preventDefault();authTab='login';renderAuth()};
  $('#tfCode').focus();
  $('#codeForm').onsubmit=guarded(async()=>{
    try{await api(url,{method:'POST',body:JSON.stringify({ticket,code:$('#tfCode').value})});await load()}
    catch(x){if(x.data&&x.data.restart){authTab='login';renderAuth()}$('#authMsg').textContent=x.message}
  });
}
function renderAuth(){
  $all('[data-authtab]').forEach(b=>b.classList.toggle('active',b.dataset.authtab===authTab));
  if(authTab==='login'){
    $('#authPanel').innerHTML=`<h1>Welcome back</h1><p>Sign in to log activity and support your team.</p><form id="loginForm"><label>Email<input id="email" type="email" required autocomplete="username" autocapitalize="off" spellcheck="false"></label><label>Password<input id="password" type="password" required autocomplete="current-password"></label><div id="captcha-box"></div><button>Sign in</button></form><p id="authMsg" class="error"></p><p><a href="/forgot" id="forgotLink">Forgot your password?</a></p>`;
    $('#forgotLink').onclick=e=>{e.preventDefault();setUrl('/forgot');showPasswordPage(null)};
    $('#loginForm').onsubmit=guarded(async()=>{try{const r=await api('/api/login',{method:'POST',body:JSON.stringify({email:$('#email').value,password:$('#password').value,captchaToken:await captchaToken()})});if(r.twoFactor)return showCodeStep(r.ticket,'/api/login/2fa');await load()}catch(x){$('#authMsg').textContent=x.message;resetCaptcha()}});
  }else{
    // An invite link (/join/CODE) or emailed invite (?invite=) is passed along automatically; on an invite-only
    // site without one, the form asks for the code.
    const linkCode=inviteCodeFromPath(),invited=!!(linkCode||pendingInviteToken);
    const inviteBit=!siteInviteOnly?'':invited?'<p class="muted">You have an invite, so you can create an account.</p>'
      :'<label>Invite code<input id="rinvite" required autocomplete="off" placeholder="From the invite someone sent you" style="text-transform:uppercase"></label><p class="muted">Active Together is invite only: you need the invite link or code someone sent you.</p>';
    $('#authPanel').innerHTML=`<h1>Create your account</h1><p>Then create a challenge or join one with an invite code.</p><form id="registerForm"><label>Name<input id="rname" required autocomplete="name"></label><label>Email<input id="remail" type="email" required autocomplete="email" autocapitalize="off" spellcheck="false"></label><label>Password<input id="rpassword" type="password" required minlength="8" autocomplete="new-password"></label>${inviteBit}<div id="captcha-box"></div><button>Create account</button></form><p class="muted">By creating an account you agree to our <a href="privacy.html" target="_blank" rel="noopener">Privacy Policy</a>.</p><p id="authMsg" class="error"></p>`;
    $('#registerForm').onsubmit=guarded(async()=>{try{await api('/api/register',{method:'POST',body:JSON.stringify({name:$('#rname').value,email:$('#remail').value,password:$('#rpassword').value,
      invite_code:linkCode||($('#rinvite')?$('#rinvite').value.trim():undefined),invite_token:pendingInviteToken||undefined,captchaToken:await captchaToken()})});await load()}catch(x){$('#authMsg').textContent=x.message;resetCaptcha()}});
  }
  renderCaptchaIfReady();
}
$all('[data-authtab]').forEach(b=>b.onclick=()=>{authTab=b.dataset.authtab;if(/^\/(forgot|reset\/)/.test(location.pathname))setUrl('/');renderAuth()});

async function loadDashboard(){dash=await api('/api/dashboard')}

// One view at a time: home, a challenge, help, or (global admins) the admin page.
function showView(id){['#homeView','#newChallengeView','#challengeView','#helpView','#adminView'].forEach(v=>$(v).classList.toggle('hidden',v!==id));window.scrollTo(0,0)}
function showHome(){challengeBack='home';setUrl('/');showView('#homeView');renderHome()}
// Challenges that are on today (where something can be logged now).
const activeToday=()=>{const d=localToday();return dash.challenges.filter(c=>c.role!=='admin'&&c.start_date<=d&&d<=c.end_date)};
function renderHome(){
  $('#hello').textContent=`Welcome, ${me.name}`;
  // Someone added me to a challenge: say who, and let me keep it or leave.
  const added=dash.challenges.filter(c=>c.added_by);
  $('#addedNotices').innerHTML=added.map(c=>`<section class="card notice" data-notice="${c.id}"><div><b>${esc(c.added_by)}</b> added you to <b>${esc(c.name)}</b> (${esc(fmtRange(c.start_date,c.end_date))}).</div><div class="btnrow"><button type="button" data-noticeopen="${c.id}">Open</button><button type="button" class="ghost" data-noticekeep="${c.id}">Keep</button><button type="button" class="ghost" data-noticeleave="${c.id}">Leave</button></div></section>`).join('');
  const ack=async id=>{await api(`/api/challenges/${id}/ack`,{method:'POST'});await loadDashboard();renderHome()};
  $all('[data-noticeopen]').forEach(b=>b.onclick=async()=>{await ack(Number(b.dataset.noticeopen));openChallenge(Number(b.dataset.noticeopen))});
  $all('[data-noticekeep]').forEach(b=>b.onclick=()=>ack(Number(b.dataset.noticekeep)).catch(e=>uiAlert(e.message)));
  $all('[data-noticeleave]').forEach(b=>b.onclick=()=>leaveChallenge(dash.challenges.find(c=>c.id===Number(b.dataset.noticeleave))));
  // People in several challenges can log one workout into all the ones it fits, from here.
  $('#homeLogBtn').classList.toggle('hidden',activeToday().length<2);
  // Syncing already: the sync help folds to one line.
  $('#syncCard').classList.toggle('folded',!!dash.syncing&&!syncOpen);
  // Each challenge is one big button: name, dates, where it is in its run, and my total.
  $('#challengeList').innerHTML=dash.challenges.map(c=>{const run=runLabel(c);return `<div class="listrow challenge-row" role="button" tabindex="0" data-open="${c.id}"><div><b>${esc(c.name)}</b><div class="muted">${esc(fmtRange(c.start_date,c.end_date))} · ${c.kind==='journey'?'journey · ':''}${isIndividual(c)?'individuals':esc(c.teams.map(t=>t.name).join(', ')||'no team yet')}${c.role==='owner'?' · owner':''}</div>${run?`<span class="status ${run==='Finished'?'finished':run.startsWith('Starts')?'upcoming':'running'}">${esc(run)}</span>`:''}</div><div class="row-total"><b>${esc(fmtTotal(c,c.myMinutes,c.myDistance,c.mySteps))}</b><span class="muted">logged by me</span></div></div>`}).join('')||'<p class="muted">You have not joined a challenge yet. Use <b>+ New challenge</b> or <b>Join with a code</b> above.</p>';
  $all('[data-open]').forEach(b=>b.onclick=()=>openChallenge(Number(b.dataset.open)).catch(e=>uiAlert(e.message)));
  loadMyActivity().catch(()=>{});
  loadAndroidCard();
  loadIosCard();
}
let syncOpen=false;
$('#syncToggle').onclick=()=>{syncOpen=!syncOpen;$('#syncCard').classList.toggle('folded',!syncOpen)};
// Log one activity into several challenges at once: every challenge that's on that day is listed, ticked
// when the entry has what it counts (minutes, distance or steps) and suits it (a cycling journey takes rides).
function openHomeLog(){
  const today=localToday();
  $('#modalBody').innerHTML=`<h2>Log activity</h2><form id="homeLogForm">
    <div class="two"><label>Activity<input id="hlType" required placeholder="Walking, cycling, gym..."></label><label>Date<input id="hlDate" type="date" required value="${today}" max="${today}"></label></div>
    <div class="two"><label>Minutes<input id="hlMinutes" type="number" min="1" inputmode="numeric"></label><label>Distance<span class="with-unit"><input id="hlDistance" type="number" min="0.01" step="0.01" inputmode="decimal"><select id="hlUnit" aria-label="Distance unit"><option value="mi">miles</option><option value="km">km</option></select></span></label></div>
    <label>Steps that day (for step challenges)<input id="hlSteps" type="number" min="1" max="200000" inputmode="numeric"></label>
    <label>Comment (optional)<input id="hlComment" maxlength="500" placeholder="How did it go?"></label>
    <fieldset class="targets"><legend>Count it in</legend><div id="hlTargets"></div></fieldset>
    <button>Save activity</button></form><p id="hlMsg" class="error"></p>`;
  const draw=()=>{
    const d=$('#hlDate').value,type=$('#hlType').value,ride=/cycl|bik(e|ing)|\bride\b|spin/i.test(type);
    const has={minutes:!!$('#hlMinutes').value,distance:!!$('#hlDistance').value,steps:!!$('#hlSteps').value};
    const list=dash.challenges.filter(c=>c.role!=='admin'&&c.start_date<=d&&d<=c.end_date);
    $('#hlTargets').innerHTML=list.map(c=>{
      const metric=c.metric==='distance'?'distance':c.metric==='steps'?'steps':'minutes',mode=c.journey&&c.journey.mode;
      const noTeam=!isIndividual(c)&&!c.teams.length,wrongWay=c.kind==='journey'&&metric!=='steps'&&((mode==='cycling')!==ride);
      const why=noTeam?'join a team first':wrongWay?(mode==='cycling'?'cycling journey: rides only':"on foot: rides don't count"):`counts ${metric==='distance'?`distance (${unitShort(c)})`:metric}`;
      const on=!noTeam&&!wrongWay&&has[metric];
      return `<label class="check-row target"><input type="checkbox" data-target="${c.id}"${on?' checked':''}${noTeam?' disabled':''}> <span><b>${esc(c.name)}</b> <span class="muted">${esc(why)}</span></span>${!isIndividual(c)&&c.teams.length>1?`<select data-targetteam="${c.id}" aria-label="Team">${c.teams.map(t=>`<option value="${t.id}">${esc(t.name)}</option>`).join('')}</select>`:''}</label>`;
    }).join('')||'<p class="muted">None of your challenges is on that day.</p>';
  };
  draw();
  for(const id of ['#hlDate','#hlType','#hlMinutes','#hlDistance','#hlSteps'])$(id).addEventListener('change',draw);
  $('#modal').showModal();$('#hlType').focus();
  $('#homeLogForm').onsubmit=guarded(async()=>{
    const targets=[...$all('#hlTargets [data-target]')].filter(x=>x.checked).map(x=>{const id=Number(x.dataset.target),c=dash.challenges.find(y=>y.id===id),sel=$(`[data-targetteam="${id}"]`);
      return {challenge_id:id,...(isIndividual(c)?{}:{team_id:sel?Number(sel.value):c.teams[0]&&c.teams[0].id})}});
    if(!targets.length){$('#hlMsg').textContent='Tick at least one challenge to count it in.';return}
    try{
      const r=await api('/api/activities',{method:'POST',body:JSON.stringify({targets,activity_type:$('#hlType').value||'Steps',activity_date:$('#hlDate').value,minutes:$('#hlMinutes').value||undefined,
        ...($('#hlDistance').value?{distance:$('#hlDistance').value,distance_unit:$('#hlUnit').value}:{}),steps:$('#hlSteps').value||undefined,comment:$('#hlComment').value})});
      $('#modal').close();await loadDashboard();renderHome();
      $('#hello').textContent=`Logged in ${r.created} challenge${r.created===1?'':'s'}. Nice one, ${me.name.split(' ')[0]}!`;
    }catch(x){$('#hlMsg').textContent=x.message}
  });
}
$('#homeLogBtn').onclick=openHomeLog;
async function loadIosCard(){
  try{
    const a=await api('/api/app/ios');
    $('#iosAppLine').classList.toggle('hidden',!a.available);
  }catch(e){$('#iosAppLine').classList.add('hidden')}
}
// Offer the Android app once it's published; shown on phones and computers alike (people often download on one and install on the other).
async function loadAndroidCard(){
  try{
    const a=await api('/api/app/android');
    $('#androidDownload').classList.toggle('hidden',!a.available);
    $('#androidMeta').textContent=a.available?`Version ${a.version}.`:'Coming soon.';
  }catch(e){$('#androidDownload').classList.add('hidden')}
}

// The challenge, its standings and my entries in it, fetched together.
let curMine=[];
// Leaderboards show the top 10 and your own place; "Show all" asks for everyone (remembered for this visit).
const fullBoards=new Set();
async function loadChallenge(id){
  const [c,lb,mine]=await Promise.all([api(`/api/challenges/${id}`),api(`/api/challenges/${id}/leaderboard${fullBoards.has(id)?'':'?top=10'}`),api(`/api/me/activities?challenge_id=${id}&limit=50`).catch(()=>({activities:[]}))]);
  curChallenge=c;curLeaderboard=lb;curMine=mine.activities;
}
async function openChallenge(id){
  await loadChallenge(id);
  setUrl(`/challenges/${id}`);
  showView('#challengeView');
  $('#backHome').innerHTML=challengeBack==='admin'?'&larr; Admin':'&larr; My challenges';
  renderChallenge();
}
async function refreshChallenge(){
  await Promise.all([loadDashboard(),loadChallenge(curChallenge.id)]);
  renderChallenge();
}

function avatarHtml(url,name,cls){
  return url?`<img src="${esc(url)}" class="${cls}" alt="">`:`<span class="${cls} avatar-placeholder">${esc((name||'?')[0].toUpperCase())}</span>`;
}

function renderChallenge(){
  const c=curChallenge;
  $('#challengeName').textContent=c.name;
  const run=runLabel(c);
  $('#challengeDates').textContent=[fmtRange(c.start_date,c.end_date),run,c.role==='admin'?'Viewing as admin':`Your role: ${c.role}`].filter(Boolean).join(' · ').toUpperCase();
  // The server already sanitized this on write (POST/PATCH /api/challenges) - safe to render as-is.
  $('#challengeDescription').innerHTML=c.description||'';
  $('#challengeDescription').classList.toggle('hidden',!c.description);
  // A virtual journey: the route under the title, the map card, and which activities count.
  const jr=c.kind==='journey'&&c.journey;
  $('#journeyLine').classList.toggle('hidden',!jr);
  if(jr)$('#journeyLine').textContent='🗺 '+fmtJourney(jr);
  $('#journeyCard').classList.toggle('hidden',!jr);
  if(jr)renderJourneyMap(c);
  const hint=jr&&!isSteps(c)?(jr.mode==='cycling'?'A cycling journey: only rides count.':"A journey on foot: rides don't count."):'';
  $('#journeyHint').textContent=hint;$('#journeyHint').classList.toggle('hidden',!hint);
  if(jr&&jr.mode==='cycling'&&!$('#activityType').value)$('#activityType').value='Cycling';
  // A new challenge's owner sees the invite on the page until someone else is in; after that it's a button.
  const memberCount=curLeaderboard.users_total??curLeaderboard.users.length,inviteOnPage=c.canManage&&memberCount<=1;
  $('#challengeCode').innerHTML=inviteOnPage?inviteBoxHtml(c):'';
  if(inviteOnPage)wireInviteBox($('#challengeCode'),c);
  const inTeam=!isIndividual(c)&&c.teams.some(t=>t.mine);
  $('#challengeActions').innerHTML=(inviteOnPage?'':'<button class="ghost" data-invite="1">Invite people</button>')+(inTeam?'<button class="ghost" data-teams="1">Teams</button>':'')
    +(c.canManage?'<button class="ghost" data-editchallenge="1">Edit challenge</button><button class="ghost" data-members="1">Members</button>':'')+(c.role!=='admin'?'<button class="ghost" data-leavechallenge="1">Leave challenge</button>':'');
  if(!inviteOnPage)$('[data-invite]').onclick=()=>openInvite(c);
  if(inTeam)$('[data-teams]').onclick=()=>openTeams(c);
  if(c.canManage){$('[data-editchallenge]').onclick=()=>openEditChallenge(c);$('[data-members]').onclick=()=>openMembers(c,{admin:me.role==='global_admin'})}
  if(c.role!=='admin')$('[data-leavechallenge]').onclick=()=>leaveChallenge(c);
  $('#exportTeamsCsv').classList.toggle('hidden',!c.canManage);
  $('#exportUsersCsv').classList.toggle('hidden',!c.canManage);
  if(c.canManage){$('#exportTeamsCsv').href=`/api/challenges/${c.id}/leaderboard/export?type=teams`;$('#exportUsersCsv').href=`/api/challenges/${c.id}/leaderboard/export?type=users`}
  const mine=dash.challenges.find(x=>x.id===c.id);
  $('#myChMinutes').textContent=fmtNum(mine?(isSteps(c)?mine.mySteps:isDistance(c)?mine.myDistance:mine.myMinutes):0);
  $('#myChMetricLabel').textContent=isSteps(c)?'my steps':isDistance(c)?`my ${unitLong(c).toLowerCase()}`:'my minutes';
  // A step challenge asks only for the day's step count and the date.
  const steps=isSteps(c);
  ['#activityTypeWrap','#minutesWrap','#timesRow','#gpxWrap'].forEach(s=>$(s).classList.toggle('hidden',steps));
  $('#stepsWrap').classList.toggle('hidden',!steps);$('#stepsNote').classList.toggle('hidden',!steps);
  $('#steps').required=steps;$('#activityType').required=!steps;
  // A distance challenge asks for distance and makes minutes optional; a minutes challenge is unchanged.
  $('#distanceWrap').classList.toggle('hidden',!isDistance(c));
  $('#distance').required=isDistance(c);
  // Either unit can be entered - the server converts. Defaults to the challenge's own unit each
  // time a different challenge is opened, but keeps the person's choice while they stay on it.
  if($('#distanceUnit').dataset.cid!==String(c.id)){$('#distanceUnit').value=unitShort(c);$('#distanceUnit').dataset.cid=String(c.id)}
  $('#minutes').required=!isDistance(c)&&!steps;
  $('#minutesLabel').textContent=isDistance(c)?'Minutes (optional)':'Minutes';
  const solo=isIndividual(c),visiting=c.role==='admin';
  // A global admin looking at a challenge they have not joined manages it but has nothing to log.
  $('#logBtn').classList.toggle('hidden',visiting);$('#recentCard').classList.toggle('hidden',visiting);
  ['#teamsCard','#teamLeaderCard','#teamWrap'].forEach(s=>$(s).classList.toggle('hidden',solo));
  // Once you're in a team, the teams card folds into the Teams button above.
  if(!solo&&c.teams.some(t=>t.mine))$('#teamsCard').classList.add('hidden');
  if(solo)$('#exportTeamsCsv').classList.add('hidden');
  $('#boardGrid').classList.toggle('single',solo);
  $('#team').required=!solo;
  const myTeams=c.teams.filter(t=>t.mine);
  $('#team').innerHTML=myTeams.map(t=>`<option value="${t.id}">${esc(t.name)}</option>`).join('')||'<option value="">Join a team first</option>';
  $('#teamList').innerHTML=teamRowsHtml(c);
  wireTeamButtons($('#teamList'));
  const myTeamIds=new Set(c.teams.filter(t=>t.mine).map(t=>t.id));
  // A gap in the ranks (the top 10, then my own place further down) shows as a dotted row.
  const gapped=(rows,draw)=>rows.map((r,i)=>(i&&r.rank>rows[i-1].rank+1?'<div class="leader-gap" aria-hidden="true">⋯</div>':'')+draw(r)).join('');
  $('#teamLeaderboard').innerHTML=gapped(curLeaderboard.teams,t=>`<div class="leader${myTeamIds.has(t.id)?' me':''}"${myTeamIds.has(t.id)?' title="Your team"':''}><span class="rank">${t.rank}</span><span class="leader-name">${avatarHtml(t.image_url,t.name,'logo-sm')}<b>${esc(t.name)}</b></span><span>${esc(fmtTotal(c,t.minutes,t.distance,t.steps))}${journeyProgress(c,t)}</span></div>`)||'<p class="muted">No teams yet.</p>';
  $('#userLeaderboard').innerHTML=gapped(curLeaderboard.users,x=>`<div class="leader${x.id===me.id?' me':''}" data-profile="${x.id}" role="button" tabindex="0" title="See ${x.id===me.id?'your':esc(x.name)+"'s"} profile"><span class="rank">${x.rank}</span><span class="leader-name">${avatarHtml(x.avatar_url,x.name,'avatar-sm')}<b>${esc(x.name)}</b>${x.id===me.id?' <span class="muted">(you)</span>':''}</span><span>${esc(fmtTotal(c,x.minutes,x.distance,x.steps))}${journeyProgress(c,x)}</span></div>`)||'<p class="muted">No members yet.</p>';
  for(const [box,shown,total] of [['#teamBoardMore',curLeaderboard.teams.length,curLeaderboard.teams_total],['#userBoardMore',curLeaderboard.users.length,curLeaderboard.users_total]]){
    const more=total>shown;$(box).innerHTML=more?`<button type="button" class="ghost" data-showall="1">Show all ${total}</button>`:'';
    if(more)$(box).querySelector('button').onclick=async()=>{fullBoards.add(c.id);await refreshChallenge()};
  }
  const recent=curMine;
  $('#recent').innerHTML=recent.map(x=>{
    const timeBit=x.start_time&&x.end_time?` · ${x.start_time}–${x.end_time}`:'';
    const commentBit=x.comment?`<div class="muted">“${esc(x.comment)}”</div>`:'';
    return `<div class="listrow"><div><b>${esc(x.activity_type)}</b><div class="muted">${x.team_name?`${esc(x.team_name)} · `:''}${esc(fmtDay(x.activity_date))}${esc(timeBit)} · ${esc(SOURCE_LABEL[x.source]||x.source)}</div>${commentBit}</div><div class="btnrow"><b>${esc(fmtEntry(c,x))}</b>${x.has_route?`<button class="ghost" data-maproute="${x.id}">Map</button>`:''}<button class="ghost" data-editactivity="${x.id}">Edit</button><button class="ghost" data-delactivity="${x.id}">Delete</button></div></div>`;
  }).join('')||'<p class="muted">No activity logged yet in this challenge.</p>';
  $all('[data-editactivity]').forEach(b=>{const x=recent.find(a=>a.id===Number(b.dataset.editactivity));b.onclick=()=>openEditActivity(x)});
  $all('[data-maproute]').forEach(b=>{const x=recent.find(a=>a.id===Number(b.dataset.maproute));b.onclick=()=>openRouteMap(x)});
  $all('[data-delactivity]').forEach(b=>b.onclick=async()=>{
    if(!await uiConfirm('Delete this activity entry?',{ok:'Delete',danger:true}))return;
    try{await api(`/api/activities/${b.dataset.delactivity}`,{method:'DELETE'});await refreshChallenge()}catch(e){uiAlert(e.message)}
  });
}

async function openEditChallenge(c,after=refreshChallenge){
  const membersData=await api(`/api/challenges/${c.id}/members`);
  $('#modalBody').innerHTML=`<h2>Edit challenge</h2>
    <form id="editChallengeForm">
      <label>Name<input id="ecName" value="${esc(c.name)}" required></label>
      <label>Description (optional)</label>
      <div class="rte" data-rte><div class="rte-toolbar"><button type="button" data-cmd="bold" title="Bold"><b>B</b></button><button type="button" data-cmd="italic" title="Italic"><i>I</i></button><button type="button" data-cmd="insertUnorderedList" title="Bullet list">&bull; List</button><button type="button" data-cmd="insertOrderedList" title="Numbered list">1. List</button><button type="button" data-cmd="createLink" title="Link">Link</button><button type="button" data-cmd="insertImage" title="Insert image">Image</button></div><div id="ecDescription" class="rte-editor" contenteditable="true" data-placeholder="What's this challenge about?">${c.description||''}</div></div>
      <div class="two"><label>Start<input id="ecStart" type="date" value="${esc(c.start_date)}" required></label><label>End<input id="ecEnd" type="date" value="${esc(c.end_date)}" required></label></div>
      <div class="two"><label>Measure<select id="ecMetric" data-metric><option value="minutes"${isDistance(c)||isSteps(c)?'':' selected'}>Active minutes</option><option value="distance"${isDistance(c)?' selected':''}>Distance</option><option value="steps"${isSteps(c)?' selected':''}>Steps</option></select></label><label data-unitwrap>Distance unit<select id="ecUnit"><option value="mi"${unitShort(c)==='mi'?' selected':''}>Miles</option><option value="km"${unitShort(c)==='km'?' selected':''}>Kilometres</option></select></label></div>
      <p class="muted">Changing what the challenge measures re-ranks the leaderboards. Entries logged without that measure count as zero toward it.</p>
      ${c.kind==='journey'?`<div><p><b>Journey:</b> ${esc(fmtJourney(c.journey))} <button type="button" class="ghost" id="ecRoute">Change route or labels</button></p><div id="ecPicker" class="hidden"></div></div>`:''}
      <label>Who takes part<select id="ecParticipation"><option value="teams"${isIndividual(c)?'':' selected'}>Teams</option><option value="individual"${isIndividual(c)?' selected':''}>Individuals only</option></select></label>
      <p class="muted">Individuals only hides teams: everyone logs straight to the challenge. Activity already logged with a team still counts on the individual leaderboard.</p>
      <button>Save changes</button>
    </form>
    <p id="ecMsg" class="error"></p>
    <h2 style="margin-top:24px">Challenge owners</h2>
    <div id="ownersList">${membersData.members.filter(m=>m.challenge_role==='owner').map(m=>`<div class="listrow"><div><b>${esc(m.name)}</b><div class="muted">${esc(m.email)}</div></div></div>`).join('')||'<p class="muted">No owners.</p>'}</div>
    <form id="addOwnerForm"><label>Add an owner by email<input id="addOwnerEmail" type="email" required placeholder="name@example.com" autocomplete="off"></label><button>Add owner</button></form>
    <p class="muted">Anyone with an account; they're added to the challenge if they aren't in it, and told.</p>
    <p id="ownerMsg" class="error"></p>
    <div class="danger-zone"><h2>Delete challenge</h2><p class="muted">Permanently deletes this challenge with all its teams, members and logged activity, for everyone. This cannot be undone.</p><button type="button" class="danger" id="deleteChallengeBtn">Delete challenge</button><p id="deleteChallengeMsg" class="error"></p></div>`;
  $('#modal').showModal();
  initRichTextEditor($('[data-rte]'));
  wireMeasureFields($('#editChallengeForm'));
  let routePicker=null;
  if(c.kind==='journey'){
    $('#ecMetric option[value="minutes"]').disabled=true;
    if(c.journey.mode==='cycling')$('#ecMetric option[value="steps"]').disabled=true;
    $('#ecRoute').onclick=()=>{
      $('#ecRoute').remove();$('#ecPicker').classList.remove('hidden');
      $('#modal').classList.add('wide');$('#modal').addEventListener('close',()=>$('#modal').classList.remove('wide'),{once:true});
      routePicker=journeyPicker($('#ecPicker'),c.journey,()=>{if(routePicker.mode()==='cycling')$('#ecMetric').value='distance';$('#ecMetric option[value="steps"]').disabled=routePicker.mode()==='cycling'});
      routePicker.show();
    };
  }
  $('#editChallengeForm').onsubmit=guarded(async e=>{
    e.preventDefault();
    try{
      const payload={name:$('#ecName').value.trim(),description:$('#ecDescription').innerHTML,start_date:$('#ecStart').value,end_date:$('#ecEnd').value,metric:$('#ecMetric').value,distance_unit:$('#ecUnit').value,participation:$('#ecParticipation').value};
      if(routePicker&&routePicker.changed()){payload.journey=routePicker.value();if(!payload.journey)throw Error('Choose a start and a finish for the journey.')}
      await api(`/api/challenges/${c.id}`,{method:'PATCH',body:JSON.stringify(payload)});
      $('#modal').close();
      await after();
    }catch(x){$('#ecMsg').textContent=x.message}
  });
  // Typing the name is the confirmation: deleting removes everyone's activity, not just the owner's.
  $('#deleteChallengeBtn').onclick=async()=>{
    const typed=await uiPrompt(`This deletes "${c.name}" and everything logged in it, for every member. Type the challenge name to confirm.`,{title:'Delete challenge',ok:'Delete'});
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
  $('#addOwnerForm').onsubmit=guarded(async e=>{
    e.preventDefault();
    try{await api(`/api/challenges/${c.id}/owners`,{method:'POST',body:JSON.stringify({email:$('#addOwnerEmail').value})});await openEditChallenge(c,after)}catch(x){$('#ownerMsg').textContent=x.message}
  });
}

// If both start and finish are set, minutes is derived from the gap between them and kept in
// sync as either changes; leaving one or both blank leaves minutes as a plain manual entry.
function minutesBetween(start,end){
  if(!start||!end)return null;
  const [sh,sm]=start.split(':').map(Number),[eh,em]=end.split(':').map(Number);
  const diff=(eh*60+em)-(sh*60+sm);
  return diff>0?diff:null;
}

// A step-challenge entry is just a day and a count.
function openEditSteps(x){
  $('#modalBody').innerHTML=`<h2>Edit steps</h2>
    <form id="editStepsForm"><div class="two"><label>Steps that day<input id="esSteps" type="number" min="1" max="200000" step="1" value="${x.steps??''}" required></label><label>Date<input id="esDate" type="date" value="${esc(x.activity_date)}" required></label></div>
      <label>Comment (optional)<input id="esComment" maxlength="500" value="${esc(x.comment||'')}"></label><button>Save changes</button></form><p id="esMsg" class="error"></p>`;
  $('#modal').showModal();
  $('#editStepsForm').onsubmit=guarded(async e=>{
    e.preventDefault();
    try{await api(`/api/activities/${x.id}`,{method:'PATCH',body:JSON.stringify({steps:$('#esSteps').value,activity_date:$('#esDate').value,comment:$('#esComment').value})});$('#modal').close();await refreshChallenge()}
    catch(err){$('#esMsg').textContent=err.message}
  });
}
function openEditActivity(x){
  const c=curChallenge,dist=isDistance(c);
  if(isSteps(c))return openEditSteps(x);
  // Distance is shown whenever the challenge measures it, or the entry already has one.
  const distField=dist||x.distance!=null?`<label>Distance${dist?'':' (optional)'}<span class="with-unit"><input id="eaDistance" type="number" min="0.01" step="0.01" inputmode="decimal" value="${x.distance??''}"${dist?' required':''}><select id="eaUnit" aria-label="Distance unit"><option value="mi">miles</option><option value="km">km</option></select></span></label>`:'';
  $('#modalBody').innerHTML=`<h2>Edit activity</h2>
    <form id="editActivityForm">
      <label>Activity<input id="eaType" value="${esc(x.activity_type)}" required></label>
      <div class="two">${distField}<label>Minutes${dist?' (optional)':''}<input id="eaMinutes" type="number" min="1" value="${x.minutes??''}"${dist?'':' required'}></label><label>Date<input id="eaDate" type="date" value="${esc(x.activity_date)}" required></label></div>
      <div class="two"><label>Start time (optional)<input id="eaStart" type="time" value="${esc(x.start_time||'')}"></label><label>Finish time (optional)<input id="eaEnd" type="time" value="${esc(x.end_time||'')}"></label></div>
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
  $('#editActivityForm').onsubmit=guarded(async e=>{
    e.preventDefault();
    try{
      await api(`/api/activities/${x.id}`,{method:'PATCH',body:JSON.stringify({activity_type:$('#eaType').value,minutes:$('#eaMinutes').value,...($('#eaDistance')?{distance:$('#eaDistance').value,distance_unit:$('#eaUnit').value}:{}),activity_date:$('#eaDate').value,start_time:$('#eaStart').value,end_time:$('#eaEnd').value,comment:$('#eaComment').value})});
      $('#modal').close();
      await refreshChallenge();
    }catch(err){$('#eaMsg').textContent=err.message}
  });
}

// A new invite code: the old link and code stop working, for anyone who hasn't joined yet.
async function newInviteCode(kind,id,what){
  if(!await uiConfirm(`Make a new invite link for ${what}? The current link and code stop working straight away; people already in aren't affected.`,{ok:'Make a new link'}))return false;
  try{await api(`/api/${kind}/${id}/invite-code`,{method:'POST'});await refreshChallenge();return true}catch(e){uiAlert(e.message);return false}
}
// The invite link and code, with Copy, the phone's share sheet where there is one, and (owners) a new link.
const inviteBoxHtml=c=>`<span class="invite-box"><span class="invite-label">Invite people</span><span class="linkrow"><code>${esc(inviteUrl(c.invite_code))}</code><button type="button" data-copylink="${esc(c.invite_code)}">Copy link</button>${navigator.share?'<button type="button" data-share="1">Share…</button>':''}</span><span class="invite-note">Or share the code <b>${esc(c.invite_code)}</b>. Anyone with the link or code can join this challenge.${c.canManage?' <button type="button" class="linkish" data-newcode="1">Make a new link</button>':''}</span></span>`;
function wireInviteBox(root,c){
  root.querySelector('[data-copylink]').onclick=e=>copyInviteLink(c.invite_code,e.currentTarget);
  const share=root.querySelector('[data-share]');
  if(share)share.onclick=()=>navigator.share({title:`Join ${c.name} on Active Together`,text:`Join me in "${c.name}" on Active Together`,url:inviteUrl(c.invite_code)}).catch(()=>{});
  const fresh=root.querySelector('[data-newcode]');
  if(fresh)fresh.onclick=async()=>{if($('#modal').open)$('#modal').close();await newInviteCode('challenges',c.id,'this challenge')};
}
function openInvite(c){
  $('#modalBody').innerHTML=`<h2>Invite people to ${esc(c.name)}</h2><div class="invite-dialog">${inviteBoxHtml(c)}</div>`;
  wireInviteBox($('#modalBody'),c);
  $('#modal').showModal();
}
// Teams, as a dialog once you're in one (the page shows them as a card until then).
function teamRowsHtml(c){
  return c.teams.map(t=>{
    const actions=[];
    if(!t.mine)actions.push(`<button data-jointeam="${t.id}">Join</button>`);
    if(t.mine)actions.push(`<button class="ghost" data-leaveteam="${t.id}" data-name="${esc(t.name)}">Leave</button>`);
    if(t.canManage)actions.push(`<button class="ghost" data-manageteam="${t.id}" data-name="${esc(t.name)}">Manage</button>`);
    const bits=[`${t.members} member(s)`];
    if(t.mine)bits.push('you are in this team');
    if(t.invite_code)bits.push(`code: <b>${esc(t.invite_code)}</b> <button type="button" class="ghost" data-copylink="${esc(t.invite_code)}" title="Copy a link that joins this team">Copy invite link</button>`);
    return `<div class="listrow"><div class="leader-name">${avatarHtml(t.image_url,t.name,'logo-sm')}<div><b>${esc(t.name)}</b><div class="muted">${bits.join(' · ')}</div></div></div><div class="btnrow">${actions.join('')}</div></div>`;
  }).join('')||'<p class="muted">No teams yet — create the first one.</p>';
}
function wireTeamButtons(root){
  root.querySelectorAll('[data-copylink]').forEach(b=>b.onclick=()=>copyInviteLink(b.dataset.copylink,b));
  root.querySelectorAll('[data-jointeam]').forEach(b=>b.onclick=async()=>{b.disabled=true;try{await api(`/api/teams/${b.dataset.jointeam}/join`,{method:'POST'});if($('#modal').open)$('#modal').close();await refreshChallenge()}catch(e){b.disabled=false;uiAlert(e.message)}});
  root.querySelectorAll('[data-manageteam]').forEach(b=>b.onclick=()=>openTeamManage(Number(b.dataset.manageteam),b.dataset.name));
  root.querySelectorAll('[data-leaveteam]').forEach(b=>b.onclick=async()=>{
    if(!await uiConfirm(`Leave team "${b.dataset.name}"? What you've logged under it stays on the team's total.`,{ok:'Leave team'}))return;
    try{await api(`/api/teams/${b.dataset.leaveteam}/leave`,{method:'POST'});if($('#modal').open)$('#modal').close();await refreshChallenge()}catch(e){uiAlert(e.message)}
  });
}
function openTeams(c){
  $('#modalBody').innerHTML=`<h2>Teams in ${esc(c.name)}</h2><div id="dlgTeams">${teamRowsHtml(c)}</div><button type="button" class="secondary" id="dlgNewTeam">+ New team</button>`;
  wireTeamButtons($('#dlgTeams'));
  $('#dlgNewTeam').onclick=()=>showFormDialog('newTeamDialog');
  $('#modal').showModal();
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
    <form id="addMemberForm"><label>${curChallenge&&curChallenge.canManage?'Add someone by email':'Add someone already in this challenge (their email)'}<input id="addMemberEmail" type="email" required placeholder="name@example.com" autocomplete="off"></label><button>Add to team</button></form>
    <p class="muted">${curChallenge&&curChallenge.canManage?"Anyone with an account: they're added to the challenge too, and told.":"To bring someone new in, share the team's invite link."}</p>
    <p id="manageMsg" class="error"></p>
    <hr><div class="btnrow"><button type="button" id="newTeamCode" class="ghost">Make a new invite link</button><button id="deleteTeamBtn" class="ghost" style="color:var(--red-text)">Delete this team</button></div>`;
  $('#newTeamCode').onclick=async()=>{if(await newInviteCode('teams',tid,`the team "${tname}"`))openTeamManage(tid,tname)};
  $('#modal').showModal();
  $('#renameTeamImage').addEventListener('change',()=>{
    const f=$('#renameTeamImage').files[0];
    if(!f)return;
    $('#renameTeamImagePreview').src=URL.createObjectURL(f);
    $('#renameTeamImagePreview').classList.remove('hidden');
  });
  $('#renameTeamForm').onsubmit=guarded(async e=>{
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
  });
  $('#addMemberForm').onsubmit=guarded(async e=>{
    e.preventDefault();
    try{await api(`/api/teams/${tid}/members`,{method:'POST',body:JSON.stringify({email:$('#addMemberEmail').value})});await openTeamManage(tid,tname);await refreshChallenge()}catch(x){$('#manageMsg').textContent=x.message}
  });
  $all('[data-removemember]').forEach(b=>b.onclick=async()=>{
    if(!await uiConfirm('Remove this person from the team? What they logged under it stays on the team total.',{ok:'Remove'}))return;
    try{await api(`/api/teams/${tid}/members/${b.dataset.removemember}`,{method:'DELETE'});await openTeamManage(tid,tname);await refreshChallenge()}catch(x){$('#manageMsg').textContent=x.message}
  });
  $('#deleteTeamBtn').onclick=async()=>{
    if(!await uiConfirm(`Delete team "${tname}"? This removes its members and any activity logged under it. This cannot be undone.`,{ok:'Delete team',danger:true}))return;
    try{await api(`/api/teams/${tid}`,{method:'DELETE'});$('#modal').close();await refreshChallenge()}catch(x){$('#manageMsg').textContent=x.message}
  };
}

// --- Leaving a challenge, and profiles with following -------------------------------------
async function leaveChallenge(c){
  if(!await uiConfirm(`Leave "${c.name}"? Everything you've logged in it is deleted, and you'll need an invite to join again.`,{ok:'Leave challenge',danger:true}))return;
  try{await api(`/api/challenges/${c.id}/leave`,{method:'POST'});await loadDashboard();showHome()}catch(e){uiAlert(e.message)}
}
const ordinal=n=>n+(n%100>=11&&n%100<=13?'th':({1:'st',2:'nd',3:'rd'}[n%10]||'th'));
function personButton(x){return `<button type="button" class="person" data-profile="${x.id}">${avatarHtml(x.avatar_url,x.name,'avatar-sm')}<span>${esc(x.name)}</span></button>`}
function followList(title,people,count,empty){
  const hidden=count-people.length;
  return `<div><h3>${title} <span class="muted">${count}</span></h3>${people.map(personButton).join('')||(hidden?'':`<p class="muted">${empty}</p>`)}${hidden>0?`<p class="muted">+ ${hidden} you don't share a challenge with</p>`:''}</div>`;
}
// Anyone's profile (or mine) in the modal: follow button, followers/following, then whatever their
// sharing level shows. People in the lists open their own profile in place.
async function openProfile(id){
  let p;
  try{p=await api(`/api/users/${id}/profile`)}catch(e){uiAlert(e.message==='Not found'?"This profile isn't available.":e.message);return}
  const first=esc(p.name.split(' ')[0]);
  const since=p.member_since?`Member since ${new Date(p.member_since+'T00:00:00').toLocaleDateString(undefined,{month:'long',year:'numeric'})}`:'';
  const counts=`<b>${p.followers_count}</b> follower${p.followers_count===1?'':'s'} · <b>${p.following_count}</b> following${p.follows_you?' · <span class="status">Follows you</span>':''}`;
  const lists=p.followers?`<div class="follow-cols">${followList('Followers',p.followers,p.followers_count,p.self?'Nobody yet.':'No followers yet.')}${followList('Following',p.following,p.following_count,'Nobody yet.')}</div>`:'';
  let body='';
  if(p.challenges){
    body+=`<div class="profile-section"><h3>${p.self?'My challenges':'Challenges you share'}</h3>${p.challenges.map(c=>`<div class="listrow"><div><b>${esc(c.name)}</b><div class="muted">${c.team?`${esc(c.team)} · `:''}${esc(fmtRange(c.start_date,c.end_date))}</div></div><div style="text-align:right"><b>${esc(fmtTotal(c,c.minutes,c.distance,c.steps))}</b>${c.rank?`<div class="muted">${ordinal(c.rank)} of ${c.of}</div>`:''}</div></div>`).join('')||'<p class="muted">No challenges yet.</p>'}</div>`;
    if(p.activities)body+=`<div class="profile-section"><h3>Recent activity</h3>${p.activities.map(a=>`<div class="listrow"><div><b>${esc(a.activity_type)}</b><div class="muted">${esc(fmtDay(a.activity_date))}${a.start_time?` · ${esc(a.start_time)}`:''} · ${esc(a.challenge_name)}</div>${a.comment?`<div class="muted">“${esc(a.comment)}”</div>`:''}</div><b>${esc(fmtEntry(a,a))}</b></div>`).join('')||'<p class="muted">Nothing logged yet.</p>'}</div>`;
  }else body+=`<p class="muted">${p.self?'Your profile is private: people only see your name and photo.':`${first} keeps their profile private.`}</p>`;
  $('#modalBody').innerHTML=`<div class="profile-head">${avatarHtml(p.avatar_url,p.name,'avatar-lg')}<div><h2>${esc(p.name)}</h2>${p.bio?`<div>${esc(p.bio)}</div>`:''}<div class="muted">${since}</div></div></div>
    <div class="row"><div>${counts}</div><div class="btnrow">${p.self?'<button class="ghost" id="profileEdit">Edit my account</button>':`<button id="followBtn" class="${p.is_following?'ghost':''}">${p.is_following?'Following ✓':'Follow'}</button>`}</div></div>
    ${lists}${body}<p id="profileMsg" class="error"></p>`;
  if(!$('#modal').open)$('#modal').showModal();
  if(p.self)$('#profileEdit').onclick=()=>{$('#modal').close();openMyAccount()};
  else $('#followBtn').onclick=async()=>{
    try{await api(`/api/users/${p.id}/follow`,{method:p.is_following?'DELETE':'POST'});await openProfile(p.id)}catch(e){$('#profileMsg').textContent=e.message}
  };
}
document.addEventListener('click',e=>{const b=e.target.closest('[data-profile]');if(b){e.preventDefault();openProfile(Number(b.dataset.profile))}});
document.addEventListener('keydown',e=>{if((e.key==='Enter'||e.key===' ')&&e.target.matches('[role="button"]')){e.preventDefault();e.target.click()}});
$('#myProfile').onclick=()=>openProfile(me.id);
// Phones: the header buttons fold into a Menu dropdown, closed by choosing anything, tapping outside or Escape.
{
  const header=document.querySelector('header'),toggle=$('#menuToggle');
  const setMenu=open=>{header.classList.toggle('open',open);toggle.setAttribute('aria-expanded',String(open))};
  toggle.onclick=e=>{e.stopPropagation();setMenu(!header.classList.contains('open'))};
  $('#headerNav').addEventListener('click',e=>{if(e.target.closest('button'))setMenu(false)});
  document.addEventListener('click',e=>{if(!header.contains(e.target))setMenu(false)});
  document.addEventListener('keydown',e=>{if(e.key==='Escape')setMenu(false)});
}

// --- Apple Shortcuts sync ---------------------------------------------------------------------
// The shared shortcut (its iCloud link comes from the server's settings) keeps its sync key in a file
// on the iPhone. "Connect this iPhone" makes a new key and opens the shortcut with it, so nobody
// copies keys around; the server keeps only a hash of the key.
const SHORTCUT_NAME='Active Together sync';
const onIPhone=()=>/iPhone|iPad|iPod/.test(navigator.userAgent)||(navigator.platform==='MacIntel'&&navigator.maxTouchPoints>1);
async function openShortcutSetup(){
  let st,cfg;
  try{[st,cfg]=await Promise.all([api('/api/me/sync-key'),api('/api/config')])}catch(e){uiAlert(e.message);return}
  const ios=onIPhone();
  $('#modalBody').innerHTML=`<h2>Apple Shortcuts sync</h2>
    <p>Sends your day's steps, exercise minutes and distance from Apple Health, twice a day. Do this on your iPhone, once.</p>
    <h3>1. Get the shortcut</h3>
    ${cfg.shortcutUrl?`<p><a class="button" href="${esc(cfg.shortcutUrl)}">Get the shortcut</a></p><p class="muted">${ios?'':'Open this page on your iPhone to do this. '}Tap <b>Add Shortcut</b> and keep its name, "${SHORTCUT_NAME}".</p>`
      :`<p class="muted">The shared shortcut isn't available yet. To make it yourself, follow <a href="/shortcut-build.html" target="_blank" rel="noopener">how to build it</a>.</p>`}
    <h3>2. Connect it to your account</h3>
    ${ios?`<p><button id="connectIPhone">Connect this iPhone</button></p><p class="muted">Opens Shortcuts and runs it once. Allow it to read Apple Health and to connect to activetogether.team when asked. Each iPhone gets its own key, so connecting one never stops another.</p>`
      :`<p class="muted">Open activetogether.team on your iPhone, tap <b>Set up Apple Shortcuts</b>, then <b>Connect this iPhone</b>.</p>`}
    <h3>3. Make it automatic</h3>
    <p class="muted">In Shortcuts, tap <b>Automation</b>, <b>+</b>, <b>Time of Day</b>: <b>21:00</b>, <b>Daily</b>, <b>Run Immediately</b>, and pick "${SHORTCUT_NAME}". Add another for <b>08:00</b>.</p>
    <div id="keyBox"></div>
    <p class="muted">${st.exists?`${st.count} ${st.count===1?'key':'keys'} in use, the newest from ${esc(fmtWhen(st.created_at))}. `:''}<a href="#" id="showKey">Show a key to paste instead</a>${st.exists?' · <a href="#" id="dropKey">Disconnect</a>':''}</p>
    <p id="keyMsg" class="error"></p>`;
  if(!$('#modal').open)$('#modal').showModal();
  const newKey=async()=>(await api('/api/me/sync-key',{method:'POST'})).key;
  if(ios)$('#connectIPhone').onclick=async()=>{
    try{const key=await newKey();location.href=`shortcuts://run-shortcut?name=${encodeURIComponent(SHORTCUT_NAME)}&input=text&text=${encodeURIComponent(key)}`}
    catch(e){$('#keyMsg').textContent=e.message}
  };
  $('#showKey').onclick=async e=>{
    e.preventDefault();
    try{
      const key=await newKey();
      $('#keyBox').innerHTML=`<p><b>Your sync key.</b> Copy it now; it won't be shown again. Run the shortcut and paste it when asked.</p><div class="linkrow"><code>${esc(key)}</code><button type="button" id="copyKey">Copy</button></div>`;
      $('#copyKey').onclick=async()=>{try{await navigator.clipboard.writeText(key);$('#copyKey').textContent='Copied'}catch(err){uiCopy('Copy your sync key:',key)}};
    }catch(err){$('#keyMsg').textContent=err.message}
  };
  if(st.exists)$('#dropKey').onclick=async e=>{
    e.preventDefault();
    if(!await uiConfirm('Disconnect? Every shortcut using your keys stops sending until you connect again.',{ok:'Disconnect',danger:true}))return;
    try{await api('/api/me/sync-key',{method:'DELETE'});openShortcutSetup()}catch(err){$('#keyMsg').textContent=err.message}
  };
}
$('#shortcutSetup').onclick=openShortcutSetup;

// --- Virtual journeys: the route picker (create and edit) and the journey map --------------------
const MODE_LABEL={foot:'on foot',cycling:'cycling'},SHAPE_LABEL={roads:'by road',straight:'as the crow flies'};
// Journey lengths read better whole: 412 miles, about 870,000 steps.
const fmtLen=n=>Number(n)>=100?Math.round(n).toLocaleString():fmtNum(n),fmtSteps=n=>(Math.round(n/1000)*1000).toLocaleString();
const viaText=j=>!j.via||!j.via.length?'':j.via.length<=2?` → ${j.via.map(v=>v.name).join(' → ')}`:` (via ${j.via.length} stops)`;
const fmtJourney=j=>`${j.from.name}${j.via&&j.via.length<=2?viaText(j):''} → ${j.to.name}${j.via&&j.via.length>2?viaText(j):''} · ${j.unit==='steps'?`${fmtSteps(j.target)} steps`:`${fmtLen(j.target)} ${j.unit==='km'?'km':'miles'}`} ${SHAPE_LABEL[j.shape]} · ${MODE_LABEL[j.mode]}`;
const journeyProgress=(c,r)=>c.kind!=='journey'||r.progress==null?'':r.finished_on?`<span class="pct" title="Finished on ${esc(r.finished_on)}">🏁</span>`:`<span class="pct">${Math.round(r.progress*100)}%</span>`;
// The start is a ring and the finish a chequered flag, so neither looks like someone's photo.
const flagIcon=(L,which)=>which==='start'?L.divIcon({className:'jm-icon',html:'<div class="jm-start" title="Start"></div>',iconSize:[18,18],iconAnchor:[9,9]})
  :L.divIcon({className:'jm-icon',html:'<div class="jm-flag">🏁</div>',iconSize:[24,24],iconAnchor:[6,22]});
const osmTiles=L=>L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19,attribution:'&copy; OpenStreetMap contributors'});
// Start and finish (and any stops on the way) come from a place search or a tap on the map; markers can be
// dragged. Once start and finish are set, a tap adds a stop where it makes the least detour. The route and
// its length are previewed as they change. Returns {show, value, mode, changed, reset}.
function journeyPicker(root,initial,onChange=()=>{}){
  // Places already saved count as labelled, so moving one keeps its name.
  const pick=p=>p?{name:p.name,lat:p.lat,lon:p.lon,custom:true}:null;
  const st={from:pick(initial?.from),to:pick(initial?.to),via:(initial?.via||[]).map(pick),shape:initial?.shape||'roads',mode:initial?.mode||'foot'};
  const snapshot=()=>JSON.stringify([st.from&&[st.from.name,st.from.lat,st.from.lon],st.to&&[st.to.name,st.to.lat,st.to.lon],st.via.filter(Boolean).map(p=>[p.name,p.lat,p.lon]),st.shape,st.mode]);
  const start=snapshot();
  let L=null,map=null,line=null,pins={},stopPins=[],timer=null,ask=0;
  // Each place: a search box (showing the place picked), its results, and the label the challenge shows for it.
  const labelBox=(key,p)=>`<label class="jp-label">Shown as<input data-jl="${key}" maxlength="120" value="${esc(p?.name||'')}" placeholder="Pick a place first"${p?'':' disabled'}></label>`;
  const placeRow=(key,label)=>`<div><label>${label}<span class="with-unit"><input data-jq="${key}" placeholder="Search for a place" autocomplete="off"><button type="button" class="secondary" data-jfind="${key}">Find</button></span></label><div class="jp-results" data-jres="${key}"></div>${labelBox(key,st[key])}</div>`;
  root.innerHTML=`<div class="two"><label>Getting there<select data-jmode><option value="foot">On foot: walking and running</option><option value="cycling">Cycling only</option></select></label><label>Route<select data-jshape><option value="roads">Along roads and paths</option><option value="straight">Straight line</option></select></label></div>
    <div class="two">${placeRow('from','Start')}${placeRow('to','Finish')}</div>
    <div data-jstops></div><button type="button" class="ghost" data-jaddstop>+ Add a stop on the way</button>
    <p class="muted">Or tap the map: the first tap sets the start, the next the finish, and any more add stops. Drag a marker to move it. Change what a place is called in its "Shown as" box (say, "The Office" instead of a postcode).</p>
    <div class="jp-map"></div><p class="jp-summary" data-jsummary>Choose a start and a finish.</p>`;
  const q=sel=>root.querySelector(sel);
  q('[data-jmode]').value=st.mode;q('[data-jshape]').value=st.shape;
  for(const k of ['from','to'])if(st[k])q(`[data-jq="${k}"]`).value=st[k].name;
  const say=(text,isError)=>{q('[data-jsummary]').textContent=text;q('[data-jsummary]').classList.toggle('error',!!isError)};
  // Stops are keyed "via0", "via1"...; start and finish "from" and "to".
  const get=k=>k.startsWith('via')?st.via[Number(k.slice(3))]:st[k];
  const put=(k,v)=>{if(k.startsWith('via'))st.via[Number(k.slice(3))]=v;else st[k]=v};
  const stopIcon=i=>L.divIcon({className:'jm-icon',html:`<div class="jm-stop">${i+1}</div>`,iconSize:[22,22],iconAnchor:[11,11]});
  function drawPins(){
    if(!map)return;
    for(const k of ['from','to']){
      if(!st[k])continue;
      if(pins[k]){pins[k].setLatLng([st[k].lat,st[k].lon]);continue}
      pins[k]=L.marker([st[k].lat,st[k].lon],{draggable:true,icon:flagIcon(L,k==='from'?'start':'finish')}).addTo(map)
        .on('dragend',e=>{const ll=e.target.getLatLng();setPoint(k,ll.lat,ll.lng)});
    }
    stopPins.forEach(m=>m.remove());
    stopPins=st.via.map((p,i)=>p&&L.marker([p.lat,p.lon],{draggable:true,icon:stopIcon(i),title:p.name}).addTo(map)
      .on('dragend',e=>{const ll=e.target.getLatLng();setPoint('via'+i,ll.lat,ll.lng)})).filter(Boolean);
  }
  function renderStops(){
    q('[data-jstops]').innerHTML=st.via.map((p,i)=>`<div class="jp-stop"><label>Stop ${i+1}<span class="with-unit"><input data-jq="via${i}" placeholder="Search for a place" autocomplete="off" value="${esc(p?.name||'')}"><button type="button" class="secondary" data-jfind="via${i}">Find</button><button type="button" class="ghost" data-jmove="${i}:-1" title="Earlier"${i?'':' disabled'}>↑</button><button type="button" class="ghost" data-jmove="${i}:1" title="Later"${i<st.via.length-1?'':' disabled'}>↓</button><button type="button" class="ghost" data-jdel="${i}" title="Remove this stop">✕</button></span></label><div class="jp-results" data-jres="via${i}"></div>${labelBox('via'+i,p)}</div>`).join('');
    wireRows();drawPins();
  }
  // A place picked from the search (name and its full description) or by a tap or drag (named by reverse
  // lookup). A label the owner typed survives the place being moved.
  async function setPoint(k,lat,lon,name,detail){
    const before=get(k),keepLabel=before&&before.custom;
    put(k,{name:keepLabel?before.name:(name||''),lat:+lat.toFixed(6),lon:+lon.toFixed(6),custom:keepLabel});
    drawPins();
    const search=()=>q(`[data-jq="${k}"]`),labelIn=()=>q(`[data-jl="${k}"]`);
    if(!name){
      if(search())search().value='Finding the place name…';
      let n='';try{n=(await api(`/api/places/reverse?lat=${lat}&lon=${lon}`)).name||''}catch(e){}
      name=n||`${lat.toFixed(3)}, ${lon.toFixed(3)}`;
      const p=get(k);if(p&&!p.custom)p.name=name;
    }
    if(search())search().value=detail||name;
    if(labelIn()&&get(k)){labelIn().disabled=false;labelIn().value=get(k).name}
    drawPins();preview();
  }
  // A tap after start and finish adds a stop in the gap where it adds the least distance.
  function addTappedStop(lat,lon){
    const pts=[st.from,...st.via.filter(Boolean),st.to],x=[lat,lon];
    let best=0,cost=Infinity;
    for(let i=0;i<pts.length-1;i++){const a=[pts[i].lat,pts[i].lon],b=[pts[i+1].lat,pts[i+1].lon],c=haversine(a,x)+haversine(x,b)-haversine(a,b);if(c<cost){cost=c;best=i}}
    st.via=st.via.filter(Boolean);
    if(st.via.length>=10){say('A journey can have up to 10 stops on the way.',true);return}
    st.via.splice(best,0,{name:'',lat,lon});renderStops();setPoint('via'+best,lat,lon);
  }
  let lastRoute=null;
  function sayRoute(){
    if(!lastRoute||!st.from||!st.to)return;
    const via=st.via.filter(Boolean),stops=via.length?` via ${via.map(s=>s.name).join(', ')}`:'',r=lastRoute;
    say(`${st.from.name} → ${st.to.name}${stops}: ${fmtLen(r.miles)} miles (${fmtLen(r.km)} km) ${SHAPE_LABEL[st.shape]}, about ${fmtSteps(r.steps)} steps`);
  }
  function preview(){
    clearTimeout(timer);onChange();
    if(!st.from||!st.to){say('Choose a start and a finish.');return}
    say('Planning the route…');
    timer=setTimeout(async()=>{
      const my=++ask;
      try{
        const r=await api('/api/journeys/preview',{method:'POST',body:JSON.stringify({journey:value()})});
        if(my!==ask)return;
        if(map){if(line)line.remove();line=L.polyline(r.points,{color:'#d40511',weight:4}).addTo(map);map.fitBounds(line.getBounds(),{padding:[24,24]})}
        lastRoute=r;sayRoute();
      }catch(e){if(my===ask){if(line){line.remove();line=null}say(e.message,true)}}
    },350);
  }
  async function find(k){
    const text=q(`[data-jq="${k}"]`).value.trim(),out=q(`[data-jres="${k}"]`);
    if(text.length<2)return;
    out.innerHTML='<span class="muted">Searching…</span>';
    try{
      const {places}=await api(`/api/places?q=${encodeURIComponent(text)}`);
      out.innerHTML=places.map((p,i)=>`<button type="button" data-i="${i}">${esc(p.detail)}</button>`).join('')||'<span class="muted">Nothing found - try another name, or tap the map.</span>';
      out.querySelectorAll('button').forEach(b=>b.onclick=()=>{const p=places[Number(b.dataset.i)];out.innerHTML='';setPoint(k,p.lat,p.lon,p.name,p.detail);if(map)map.setView([p.lat,p.lon],Math.max(map.getZoom(),9))});
    }catch(e){out.innerHTML=`<span class="error">${esc(e.message)}</span>`}
  }
  function wireRows(){
    root.querySelectorAll('[data-jfind]').forEach(b=>b.onclick=()=>find(b.dataset.jfind));
    root.querySelectorAll('[data-jq]').forEach(inp=>{
      const k=inp.dataset.jq;
      inp.onkeydown=e=>{if(e.key==='Enter'){e.preventDefault();find(k)}};
    });
    // The label: what the challenge calls the place. Typing updates the summary without planning again;
    // left empty, it goes back to the map's name.
    root.querySelectorAll('[data-jl]').forEach(inp=>{
      const k=inp.dataset.jl;
      inp.oninput=()=>{const p=get(k);if(!p)return;const v=inp.value.trim().slice(0,120);if(v){p.name=v;p.custom=true}onChange();sayRoute()};
      inp.onblur=()=>{const p=get(k);if(p&&!inp.value.trim()){p.custom=false;const text=q(`[data-jq="${k}"]`).value.split(',')[0].trim();p.name=text||p.name;inp.value=p.name;sayRoute()}};
      inp.onkeydown=e=>{if(e.key==='Enter')e.preventDefault()};
    });
    root.querySelectorAll('[data-jmove]').forEach(b=>b.onclick=()=>{const [i,d]=b.dataset.jmove.split(':').map(Number);[st.via[i],st.via[i+d]]=[st.via[i+d],st.via[i]];renderStops();preview()});
    root.querySelectorAll('[data-jdel]').forEach(b=>b.onclick=()=>{st.via.splice(Number(b.dataset.jdel),1);renderStops();preview()});
  }
  q('[data-jaddstop]').onclick=()=>{
    if(st.via.length>=10){say('A journey can have up to 10 stops on the way.',true);return}
    st.via.push(null);renderStops();q(`[data-jq="via${st.via.length-1}"]`).focus();
  };
  q('[data-jmode]').onchange=e=>{st.mode=e.target.value;preview()};
  q('[data-jshape]').onchange=e=>{st.shape=e.target.value;preview()};
  const clean=p=>({name:p.name,lat:p.lat,lon:p.lon});
  const value=()=>st.from&&st.to?{from:clean(st.from),to:clean(st.to),via:st.via.filter(Boolean).map(clean),shape:st.shape,mode:st.mode}:null;
  renderStops();
  return {
    async show(){
      if(map){map.invalidateSize();return}
      try{L=await loadLeaflet()}catch(e){say(e.message,true);return}
      map=L.map(q('.jp-map')).setView([54.5,-3],5);osmTiles(L).addTo(map);
      map.on('click',e=>{const {lat,lng}=e.latlng;if(!st.from)setPoint('from',lat,lng);else if(!st.to)setPoint('to',lat,lng);else addTappedStop(lat,lng)});
      drawPins();
      if(st.from&&st.to)preview();
    },
    value,mode:()=>st.mode,
    changed:()=>snapshot()!==start,
    reset(){st.from=st.to=null;st.via=[];lastRoute=null;for(const k of ['from','to']){if(pins[k])pins[k].remove();q(`[data-jq="${k}"]`).value='';q(`[data-jres="${k}"]`).innerHTML='';const l=q(`[data-jl="${k}"]`);l.value='';l.disabled=true}pins={};renderStops();if(line){line.remove();line=null}say('Choose a start and a finish.')},
  };
}
// The journey map on a challenge page: the route, start and finish flags, and each team's logo or
// person's photo at their virtual position. Pins sharing a spot fan out round it.
let journeyMap=null;
async function renderJourneyMap(c){
  const el=$('#journeyMap');
  try{
    const [L,j]=await Promise.all([loadLeaflet(),api(`/api/challenges/${c.id}/journey`)]);
    if(!curChallenge||curChallenge.id!==c.id)return;
    if(journeyMap){journeyMap.remove();journeyMap=null}
    el.innerHTML='';
    journeyMap=L.map(el,{scrollWheelZoom:false});osmTiles(L).addTo(journeyMap);
    const line=L.polyline(j.route,{color:'#d40511',weight:4,opacity:.85}).addTo(journeyMap);
    L.marker([j.journey.from.lat,j.journey.from.lon],{icon:flagIcon(L,'start')}).addTo(journeyMap).bindTooltip(`Start: ${esc(j.journey.from.name)}`);
    L.marker([j.journey.to.lat,j.journey.to.lon],{icon:flagIcon(L,'finish')}).addTo(journeyMap).bindTooltip(`Finish: ${esc(j.journey.to.name)}`);
    const unitWord=j.journey.unit==='steps'?'steps':j.journey.unit;
    (j.journey.via||[]).forEach((v,i)=>L.marker([v.lat,v.lon],{icon:L.divIcon({className:'jm-icon',html:`<div class="jm-stop">${i+1}</div>`,iconSize:[22,22],iconAnchor:[11,11]})})
      .addTo(journeyMap).bindTooltip(`Stop ${i+1}: ${esc(v.name)} · ${fmtLen(v.at)} ${unitWord} in`));
    const groups={};
    for(const mk of j.markers)(groups[`${mk.lat.toFixed(3)},${mk.lon.toFixed(3)}`]??=[]).push(mk);
    for(const g of Object.values(groups))g.forEach((mk,i)=>{
      const r=g.length>1?20+g.length*2:0,a=2*Math.PI*i/g.length,dx=Math.round(r*Math.cos(a)),dy=Math.round(r*Math.sin(a));
      const face=mk.image_url?`<img src="${esc(mk.image_url)}" alt="">`:esc((mk.name||'?')[0].toUpperCase());
      L.marker([mk.lat,mk.lon],{icon:L.divIcon({className:'jm-icon',html:`<div class="jm-pin${mk.finished_on?' done':''}">${face}</div>`,iconSize:[38,38],iconAnchor:[19-dx,19-dy],popupAnchor:[dx,dy-18]}),zIndexOffset:Math.round(mk.progress*1000),title:mk.name})
        .addTo(journeyMap)
        .bindPopup(`<b>${esc(mk.name)}</b><br>${esc(fmtTotal(c,0,mk.distance,mk.steps))} · ${Math.round(mk.progress*100)}%${mk.finished_on?`<br>🏁 Finished on ${esc(mk.finished_on)}`:mk.next?`<br>Next: ${esc(mk.next.name)}, ${esc(mk.next.remaining>=10?Math.round(mk.next.remaining).toLocaleString():fmtNum(mk.next.remaining))} ${unitWord} to go`:''}`);
    });
    journeyMap.fitBounds(line.getBounds(),{paddingTopLeft:[56,40],paddingBottomRight:[40,40]});
    const done=j.markers.filter(m=>m.finished_on).length;
    $('#journeyMeta').textContent=`${done} of ${j.markers.length} ${j.by==='team'?'teams':'people'} finished`;
  }catch(e){el.innerHTML=`<p class="error">${esc(e.message)}</p>`}
}

// --- Administration (global admins) ---------------------------------------------------------
let challengeBack='home',adminTab='users',adminUsers=[],adminChallenges=[];
const MEASURE_LABEL=c=>c.metric==='steps'?'Steps':c.metric==='distance'?`Distance (${c.distance_unit==='km'?'km':'miles'})`:'Active minutes';
const STATE_LABEL={running:'Running',upcoming:'Not started',finished:'Finished'};
const plural=(n,one,many)=>`${n} ${n===1?one:many}`;
async function showAdmin(){
  if(me.role!=='global_admin')return showHome();
  showView('#adminView');
  api('/api/admin/settings').then(s=>{$('#inviteOnly').checked=s.inviteOnly}).catch(()=>{});
  await renderAdmin();
}
$('#inviteOnly').onchange=async e=>{
  try{const s=await api('/api/admin/settings',{method:'PATCH',body:JSON.stringify({inviteOnly:e.target.checked})});e.target.checked=s.inviteOnly;siteInviteOnly=s.inviteOnly;$('#inviteOnlyMsg').textContent=s.inviteOnly?'Saved: new accounts now need an invite.':'Saved: anyone can create an account.'}
  catch(x){e.target.checked=!e.target.checked;$('#inviteOnlyMsg').textContent=x.message}
};
function setAdminTab(t){
  adminTab=t;
  setUrl(t==='challenges'?'/admin/challenges':t==='log'?'/admin/log':'/admin',true);
  $all('[data-admintab]').forEach(b=>b.classList.toggle('active',b.dataset.admintab===t));
  $('#adminUsers').classList.toggle('hidden',t!=='users');
  $('#adminChallenges').classList.toggle('hidden',t!=='challenges');
  $('#adminLog').classList.toggle('hidden',t!=='log');
  if(t==='log')renderAuditLog();
}
async function renderAdmin(){
  setAdminTab(adminTab);
  // Admins without two-step sign-in are nudged to turn it on.
  $('#adminTwoStep').classList.toggle('hidden',!!me.two_factor);
  try{
    const c=await api('/api/admin/challenges');adminChallenges=c.challenges;
    await loadAdminUsers();
  }catch(e){$('#adminUserList').innerHTML=$('#adminChallengeList').innerHTML=`<p class="error">${esc(e.message)}</p>`;return}
  renderAdminChallenges();
}
// Users come from the server a page at a time (50), searched there too, so a big site stays quick.
let adminUserTotal=0,adminUserQuery='';
async function loadAdminUsers(more=false){
  const q=$('#adminUserSearch').value.trim();
  if(!more){adminUsers=[];adminUserQuery=q}
  const r=await api(`/api/admin/users?limit=50&offset=${adminUsers.length}${q?`&q=${encodeURIComponent(q)}`:''}`);
  if(q!==adminUserQuery)return;
  adminUsers=adminUsers.concat(r.users);adminUserTotal=r.total;
  renderAdminUsers();
}
function renderAdminUsers(){
  const rows=adminUsers;
  $('#adminUserCount').textContent=String(adminUserTotal);
  $('#adminUsersMore').classList.toggle('hidden',adminUsers.length>=adminUserTotal);
  $('#adminUserList').innerHTML=rows.map(x=>`<div class="adminrow"><div><div class="leader-name">${avatarHtml(x.avatar_url,x.name,'avatar-sm')}<b>${esc(x.name)}</b>${x.id===me.id?' <span class="muted">(you)</span>':''}</div>
    <div class="facts"><span>${esc(x.email)}</span><span>${plural(x.challenges,'challenge','challenges')}</span><span>${plural(x.activities,'activity','activities')}</span><span>${x.last_activity?`last active ${esc(fmtDate(x.last_activity))}`:'no activity yet'}</span>${x.tickets?`<span>${plural(x.tickets,'ticket','tickets')}</span>`:''}<span>joined ${esc(fmtDate(String(x.created_at||'').slice(0,10)))}</span></div></div>
    <div class="btnrow">${x.two_factor?'<span class="status" title="Two-step sign-in is on">2-step</span>':''}${x.deactivated_at?statusPillFor('deactivated','Deactivated'):''}${statusPillFor(x.role,x.role==='global_admin'?'Global admin':'Member')}<button class="ghost" data-edituser="${x.id}">Edit</button></div></div>`).join('')||'<p class="muted">No users match.</p>';
  $all('[data-edituser]').forEach(b=>{const x=adminUsers.find(x2=>x2.id===Number(b.dataset.edituser));b.onclick=()=>openEditUser(x)});
}
function renderAdminChallenges(){
  const q=$('#adminChallengeSearch').value.trim().toLowerCase(),st=$('#adminChallengeState').value;
  const rows=adminChallenges.filter(c=>(!st||c.state===st)&&(!q||`${c.name} ${c.owners||''} ${c.creator_name||''} ${c.invite_code}`.toLowerCase().includes(q)));
  $('#adminChallengeCount').textContent=rows.length===adminChallenges.length?String(rows.length):`${rows.length} of ${adminChallenges.length}`;
  $('#adminChallengeList').innerHTML=rows.map(c=>`<div class="adminrow"><div><b>${esc(c.name)}</b>
    <div class="facts"><span>${esc(fmtRange(c.start_date,c.end_date))}</span><span>${esc(MEASURE_LABEL(c))}</span><span>${c.participation==='individual'?'Individuals':plural(c.teams,'team','teams')}</span><span>${plural(c.members,'member','members')}</span><span>${plural(c.activities,'activity','activities')}</span><span>owner: ${esc(c.owners||c.creator_name||'none')}</span><span>code ${esc(c.invite_code)}</span>${c.state==='finished'?`<span title="Finished challenges and their activity are deleted 60 days after they end">deleted on ${esc(fmtDate(c.purge_date))}</span>`:''}</div></div>
    <div class="btnrow">${statusPillFor(c.state,STATE_LABEL[c.state])}<button data-adminopen="${c.id}">Open</button><button class="ghost" data-adminmembers="${c.id}">Members</button><button class="ghost" data-adminedit="${c.id}">Edit</button></div></div>`).join('')||'<p class="muted">No challenges match.</p>';
  $all('[data-adminmembers]').forEach(b=>b.onclick=()=>openMembers(adminChallenges.find(c=>c.id===Number(b.dataset.adminmembers)),{admin:true}));
  $all('[data-adminopen]').forEach(b=>b.onclick=()=>{challengeBack='admin';openChallenge(Number(b.dataset.adminopen)).catch(e=>uiAlert(e.message))});
  $all('[data-adminedit]').forEach(b=>b.onclick=async()=>{
    try{const c=await api(`/api/challenges/${b.dataset.adminedit}`);challengeBack='admin';await openEditChallenge(c,async()=>{await loadDashboard();await renderAdmin()})}catch(e){uiAlert(e.message)}
  });
}
// Who is in a challenge, and adding or removing anyone (global admins). People are picked from the
// admin user list by name or email; a team challenge can put them straight into a team.
// Who is in a challenge: its owners (from the challenge page) and global admins (from Admin) can add anyone
// with an account (who is then told), see each person's entries, delete ones that shouldn't count, and
// remove people. Admins get name suggestions as they type.
async function openMembers(c,{admin=false,note=''}={}){
  let d;
  try{d=await api(`/api/challenges/${c.id}/members`)}catch(e){uiAlert(e.message);return}
  const individual=c.participation==='individual';
  $('#modalBody').innerHTML=`<h2>Members of ${esc(c.name)}</h2>
    <p class="muted">${plural(d.members.length,'member','members')}${individual?' · individuals':` · ${plural(d.teams.length,'team','teams')}`}</p>
    <form id="amAddForm" class="card" style="padding:14px;margin:12px 0">
      <label>Add someone by email<input id="amUser" type="${admin?'text':'email'}" ${admin?'list="amUserList" placeholder="Start typing a name or email"':'placeholder="name@example.com"'} required autocomplete="off" spellcheck="false"></label>
      ${admin?'<datalist id="amUserList"></datalist>':''}
      <div class="two">${individual?'':`<label>Team<select id="amTeam"><option value="">No team yet</option>${d.teams.map(t=>`<option value="${t.id}">${esc(t.name)}</option>`).join('')}</select></label>`}
      <label>Role<select id="amRole"><option value="member">Member</option><option value="owner">Owner</option></select></label></div>
      <button>Add to challenge</button><p class="muted">Anyone with an account. They're told, and can leave if they didn't expect it. No account yet? Share the invite link.</p></form>
    <p id="amMsg" class="${note?'muted':'error'}">${esc(note)}</p>
    <div>${d.members.map(x=>`<div class="member-block"><div class="listrow"><div><div class="leader-name">${avatarHtml(x.avatar_url,x.name,'avatar-sm')}<b>${esc(x.name)}</b>${x.id===me.id?' <span class="muted">(you)</span>':''}</div>
      <div class="muted">${esc(x.email)} · ${x.role==='owner'?'owner':'member'}${x.teams?` · ${esc(x.teams)}`:individual?'':' · no team'} · ${plural(x.entries,'entry','entries')}${x.deactivated_at?' · deactivated':''}</div></div>
      <div class="btnrow">${x.entries?`<button type="button" class="ghost" data-amentries="${x.id}" aria-expanded="false">Entries</button>`:''}${x.id!==me.id||admin?`<button type="button" class="ghost" data-amremove="${x.id}">Remove</button>`:''}</div></div>
      <div class="member-entries hidden" data-amlist="${x.id}"></div></div>`).join('')||'<p class="muted">Nobody is in this challenge.</p>'}</div>`;
  if(!$('#modal').open)$('#modal').showModal();
  const say=(text,ok)=>{$('#amMsg').className=ok?'muted':'error';$('#amMsg').textContent=text};
  const refresh=async msg=>{if(admin)await renderAdmin();else if(curChallenge&&curChallenge.id===c.id)await refreshChallenge();await openMembers(admin?(adminChallenges.find(x=>x.id===c.id)||c):c,{admin,note:msg})};
  // Admins: suggestions from the server as they type ("Name <email>"); the email is what's sent.
  if(admin){let timer;$('#amUser').addEventListener('input',()=>{clearTimeout(timer);const q=$('#amUser').value.trim();if(q.length<2||q.includes('<'))return;
    timer=setTimeout(async()=>{try{const r=await api(`/api/admin/users?q=${encodeURIComponent(q)}&limit=8`);$('#amUserList').innerHTML=r.users.filter(x=>!x.deactivated_at).map(x=>`<option value="${esc(`${x.name} <${x.email}>`)}"></option>`).join('')}catch(e){}},250)})}
  $('#amAddForm').onsubmit=guarded(async()=>{
    const v=$('#amUser').value.trim(),email=(v.match(/<([^>]+)>\s*$/)||[,v])[1].trim();
    try{
      const r=await api(`/api/challenges/${c.id}/members`,{method:'POST',body:JSON.stringify({email,role:$('#amRole').value,team_id:$('#amTeam')?$('#amTeam').value:undefined})});
      await refresh(r.added?`Added ${r.user.name}. They've been told.`:`${r.user.name} was already in; their team and role are updated.`);
    }catch(x){say(x.message)}
  });
  // A member's entries, newest first, each with Delete.
  $all('[data-amentries]').forEach(b=>b.onclick=async()=>{
    const id=Number(b.dataset.amentries),box=$(`[data-amlist="${id}"]`),open=box.classList.toggle('hidden')===false;
    b.setAttribute('aria-expanded',String(open));
    if(!open)return;
    box.innerHTML='<p class="muted">Loading…</p>';
    try{
      const {activities}=await api(`/api/challenges/${c.id}/members/${id}/activities`);
      const cc={metric:c.metric,distance_unit:c.distance_unit};
      box.innerHTML=activities.map(a=>`<div class="listrow"><div><b>${esc(a.activity_type)}</b><div class="muted">${esc(fmtDay(a.activity_date))}${a.start_time?` · ${esc(a.start_time)}`:''}${a.team_name?` · ${esc(a.team_name)}`:''} · ${esc(SOURCE_LABEL[a.source]||a.source)}${a.comment?` · “${esc(a.comment)}”`:''}</div></div><div class="btnrow"><b>${esc(fmtEntry(cc,a))}</b><button type="button" class="ghost" data-amdel="${a.id}">Delete</button></div></div>`).join('')||'<p class="muted">No entries.</p>';
      box.querySelectorAll('[data-amdel]').forEach(x=>x.onclick=async()=>{
        if(!await uiConfirm("Delete this entry? It stops counting straight away, and the person can't undo it.",{ok:'Delete entry',danger:true}))return;
        try{await api(`/api/activities/${x.dataset.amdel}`,{method:'DELETE'});await refresh('Entry deleted.')}catch(err){say(err.message)}
      });
    }catch(e){box.innerHTML=`<p class="error">${esc(e.message)}</p>`}
  });
  $all('[data-amremove]').forEach(b=>b.onclick=async()=>{
    const x=d.members.find(m=>m.id===Number(b.dataset.amremove));
    const lastOwner=x.role==='owner'&&d.members.filter(m=>m.role==='owner').length===1;
    if(!await uiConfirm(`Remove ${x.name} from "${c.name}"?${x.entries?` Their ${plural(x.entries,'entry','entries')} in it will be deleted.`:''}${lastOwner?' They are its only owner, so only global admins will be able to manage it.':''}`,{ok:'Remove',danger:true}))return;
    try{await api(`/api/challenges/${c.id}/members/${x.id}`,{method:'DELETE'});await refresh(`Removed ${x.name}.`)}
    catch(err){say(err.message)}
  });
}
const statusPillFor=(cls,label)=>`<span class="status ${esc(cls)}">${esc(label)}</span>`;
$('#adminBtn').onclick=()=>showAdmin();
$('#adminBack').onclick=()=>showHome();
$('#adminSupport').onclick=()=>showHelp();
$all('[data-admintab]').forEach(b=>b.onclick=()=>setAdminTab(b.dataset.admintab));
{let timer;$('#adminUserSearch').oninput=()=>{clearTimeout(timer);timer=setTimeout(()=>loadAdminUsers().catch(e=>uiAlert(e.message)),250)}}
$('#adminUsersMore').onclick=()=>loadAdminUsers(true).catch(e=>uiAlert(e.message));
$('#adminTwoStepBtn').onclick=openMyAccount;
// The audit log: what admins and owners have done to other people's accounts and entries.
let auditEntries=[];
async function renderAuditLog(more=false){
  const q=$('#auditSearch').value.trim();
  try{
    const r=await api(`/api/admin/audit?limit=100&offset=${more?auditEntries.length:0}${q?`&q=${encodeURIComponent(q)}`:''}`);
    auditEntries=more?auditEntries.concat(r.entries):r.entries;
    $('#auditList').innerHTML=auditEntries.map(e=>`<div class="listrow audit-row"><div><b>${esc(e.actor_name||'Someone')}</b> ${esc(e.action)}${e.target_name?` · <b>${esc(e.target_name)}</b>`:''}${e.challenge_name?` · ${esc(e.challenge_name)}`:''}${e.detail?`<div class="muted">${esc(e.detail)}</div>`:''}</div><span class="muted">${esc(fmtWhen(e.at))}</span></div>`).join('')||'<p class="muted">Nothing recorded yet.</p>';
    $('#auditMore').classList.toggle('hidden',!r.more);
  }catch(e){$('#auditList').innerHTML=`<p class="error">${esc(e.message)}</p>`}
}
{let timer;$('#auditSearch').oninput=()=>{clearTimeout(timer);timer=setTimeout(()=>renderAuditLog(),250)}}
$('#auditMore').onclick=()=>renderAuditLog(true);
$('#adminChallengeSearch').oninput=renderAdminChallenges;
$('#adminChallengeState').onchange=renderAdminChallenges;
$('#adminNewUserBtn').onclick=()=>{$('#newUser').classList.toggle('hidden');if(!$('#newUser').classList.contains('hidden'))$('#newUser [name=name]').focus()};
$('#newUser').onsubmit=guarded(async e=>{
  e.preventDefault();
  try{await api('/api/admin/users',{method:'POST',body:JSON.stringify(Object.fromEntries(new FormData(e.target)))});e.target.reset();e.target.classList.add('hidden');$('#newUserMsg').textContent='';await renderAdmin()}
  catch(x){$('#newUserMsg').textContent=x.message}
});

function openEditUser(x){
  $('#modalBody').innerHTML=`<h2>Edit ${esc(x.name)}</h2>
    <form id="editUserForm">
      <label>Name<input id="euName" value="${esc(x.name)}" required></label>
      <label>Email<input id="euEmail" type="email" value="${esc(x.email)}" required></label>
      <label>Role<select id="euRole"><option value="member"${x.role==='member'?' selected':''}>Member</option><option value="global_admin"${x.role==='global_admin'?' selected':''}>Global admin</option></select></label>
      <label>Reset password (leave blank to keep current)<input id="euPassword" type="password" minlength="8" autocomplete="new-password"></label>
      <button>Save changes</button>
    </form>
    <p class="muted">Or <button type="button" class="linkish" id="euResetLink">make a reset link</button> for them to choose their own password (works once, for 24 hours).</p>
    ${x.two_factor&&x.id!==me.id?'<p class="muted">Two-step sign-in is on. Lost their phone and backup codes? <button type="button" class="linkish" id="euTwoStepOff">Turn it off for them</button></p>':''}
    <p id="euMsg" class="error"></p>
    ${x.id===me.id?'':`<div class="danger-zone"><h2>${x.deactivated_at?'Deactivated':'Deactivate or delete'}</h2>
      <p class="muted">${x.deactivated_at?`Deactivated ${esc(String(x.deactivated_at).slice(0,10))}. They can't sign in; their activity still counts.`:'Deactivating signs them out everywhere and stops them signing in. Their activity stays on the leaderboards, and you can reactivate them at any time.'}</p>
      <div class="btnrow"><button type="button" class="${x.deactivated_at?'secondary':'danger'}" id="euActive">${x.deactivated_at?'Reactivate account':'Deactivate account'}</button><button type="button" class="danger" id="euDelete">Delete account</button></div>
      <p class="muted">Deleting removes the account with all their activity, routes, team memberships and tickets, for good. Challenges and teams they created stay, credited to you.</p></div>`}`;
  $('#modal').showModal();
  if($('#euTwoStepOff'))$('#euTwoStepOff').onclick=async()=>{
    if(!await uiConfirm(`Turn off two-step sign-in for ${x.name}? They'll sign in with just their password until they set it up again.`,{ok:'Turn off',danger:true}))return;
    try{await api(`/api/admin/users/${x.id}`,{method:'PATCH',body:JSON.stringify({twoFactor:false})});$('#modal').close();renderAdmin()}catch(err){$('#euMsg').textContent=err.message}
  };
  $('#euResetLink').onclick=async()=>{
    try{const r=await api(`/api/admin/users/${x.id}/reset-link`,{method:'POST'});await uiCopy(`Send this link to ${x.name}. It works once, until ${new Date(r.expiresAt).toLocaleString()}. Any earlier link stops working.`,r.url)}
    catch(err){$('#euMsg').textContent=err.message}
  };
  if($('#euActive'))$('#euActive').onclick=async()=>{
    if(!x.deactivated_at&&!await uiConfirm(`Deactivate ${x.name}? They'll be signed out and can't sign in until reactivated.`,{ok:'Deactivate',danger:true}))return;
    try{await api(`/api/admin/users/${x.id}`,{method:'PATCH',body:JSON.stringify({active:!!x.deactivated_at})});$('#modal').close();renderAdmin()}catch(err){$('#euMsg').textContent=err.message}
  };
  if($('#euDelete'))$('#euDelete').onclick=async()=>{
    const typed=await uiPrompt(`This permanently deletes ${x.name} (${x.email}) and everything they logged. Type their email to confirm.`,{title:'Delete account',ok:'Delete'});
    if(typed===null)return;
    if(typed.trim().toLowerCase()!==x.email.toLowerCase()){$('#euMsg').textContent='The email did not match, so nothing was deleted.';return}
    try{await api(`/api/admin/users/${x.id}`,{method:'DELETE'});$('#modal').close();renderAdmin()}catch(err){$('#euMsg').textContent=err.message}
  };
  $('#editUserForm').onsubmit=guarded(async e=>{
    e.preventDefault();
    const payload={name:$('#euName').value.trim(),email:$('#euEmail').value.trim(),role:$('#euRole').value};
    const pw=$('#euPassword').value;
    if(pw)payload.password=pw;
    try{await api(`/api/admin/users/${x.id}`,{method:'PATCH',body:JSON.stringify(payload)});$('#modal').close();renderAdmin()}catch(err){$('#euMsg').textContent=err.message}
  });
}

function openMyAccount(){
  $('#modalBody').innerHTML=`<h2>My account</h2>
    <form id="accountForm">
      <label>Avatar (optional)</label>
      <div id="acctAvatarPreview">${avatarHtml(me.avatar_url,me.name,'imgpreview')}</div>
      <input type="file" id="acctAvatar" accept="image/*">
      <label>Name<input id="acctName" value="${esc(me.name)}" required></label>
      <label>Email<input id="acctEmail" type="email" value="${esc(me.email)}" required autocomplete="email"></label>
      <label>About me (optional)<input id="acctBio" maxlength="280" value="${esc(me.bio||'')}" placeholder="A line for your profile"></label>
      <label>Profile sharing<select id="acctSharing">
        <option value="private"${me.profile_sharing==='private'?' selected':''}>Private - name and photo only</option>
        <option value="summary"${!me.profile_sharing||me.profile_sharing==='summary'?' selected':''}>Totals - plus my total and rank in each shared challenge</option>
        <option value="full"${me.profile_sharing==='full'?' selected':''}>Full - plus my recent activity in shared challenges</option>
      </select></label>
      <p class="muted">Only people in a challenge with you can see your profile, and only for challenges you share. Leaderboard totals are always visible to them; GPS routes never are.</p>
      <label class="check-row"><input type="checkbox" id="acctNotify"${me.notify_email?' checked':''}> <span>Email me when support replies to my tickets, or someone adds me to a challenge</span></label>
      ${me.role==='global_admin'?`<label class="check-row"><input type="checkbox" id="acctNotifyAdmin"${me.notify_admin?' checked':''}> <span>Email me about new support tickets and replies (global admins)</span></label>`:''}
      <label>New password (leave blank to keep current)<input id="acctNewPassword" type="password" minlength="8" autocomplete="new-password"></label>
      <label>Current password (required to change email or password)<input id="acctCurrentPassword" type="password" autocomplete="current-password"></label>
      <button>Save changes</button>
    </form>
    <p id="acctMsg" class="error"></p>
    <div class="twostep"><h2>Two-step sign-in</h2><div id="tsBody"></div></div>
    <div class="danger-zone"><h2>Delete my account</h2>
      <p class="muted">Deletes your account, everything you've logged, your routes, follows and support tickets, straight away. A challenge you own alone passes to its longest-standing member, or is deleted if nobody else is in it. This can't be undone.</p>
      <form id="deleteAccountForm"><label>Your password<input id="deletePassword" type="password" required autocomplete="current-password"></label><button class="danger">Delete my account</button></form>
      <p id="deleteMsg" class="error"></p></div>`;
  $('#modal').showModal();
  renderTwoStep();
  $('#deleteAccountForm').onsubmit=guarded(async e=>{
    e.preventDefault();
    if(!await uiConfirm('Delete your Active Together account and everything in it? This cannot be undone.',{ok:'Delete my account',danger:true}))return;
    try{await api('/api/me',{method:'DELETE',body:JSON.stringify({password:$('#deletePassword').value})});location.href='/'}catch(x){$('#deleteMsg').textContent=x.message}
  });
  $('#acctAvatar').addEventListener('change',()=>{
    const f=$('#acctAvatar').files[0];
    if(!f)return;
    $('#acctAvatarPreview').innerHTML=`<img src="${URL.createObjectURL(f)}" class="imgpreview" alt="">`;
  });
  $('#accountForm').onsubmit=guarded(async e=>{
    e.preventDefault();
    const payload={name:$('#acctName').value.trim(),email:$('#acctEmail').value.trim(),bio:$('#acctBio').value,profileSharing:$('#acctSharing').value,notifyEmail:$('#acctNotify').checked,...($('#acctNotifyAdmin')?{notifyAdmin:$('#acctNotifyAdmin').checked}:{})};
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
  });
}
$('#myAccount').onclick=openMyAccount;
// Two-step sign-in in My account: off (set up: scan a QR code, type the first code, keep the backup codes),
// or on (new backup codes, or switch off - both need the password).
let qrReady=null;
const loadQr=()=>qrReady||=new Promise((ok,fail)=>{const js=document.createElement('script');js.src='/vendor/qrcode-generator-2.0.4/qrcode.js';js.onload=()=>ok(window.qrcode);js.onerror=()=>{qrReady=null;fail(Error('Could not load the QR code'))};document.head.appendChild(js)});
const backupList=codes=>`<p><b>Your backup codes.</b> Each works once, in place of a code from the app, if you lose your phone. Keep them somewhere safe (a password manager is ideal): they won't be shown again.</p><pre class="backup-codes">${codes.map(esc).join('\n')}</pre><button type="button" class="ghost" id="tsCopyCodes">Copy the codes</button>`;
function renderTwoStep(){
  const box=$('#tsBody');if(!box)return;
  if(me.two_factor){
    box.innerHTML=`<p class="muted"><b>On.</b> Signing in asks for a code from your authenticator app (or a backup code) after your password.</p>
      <form id="tsManage"><label>Your password<input id="tsPassword" type="password" required autocomplete="current-password"></label><div class="btnrow"><button type="button" id="tsNewCodes" class="ghost">New backup codes</button><button type="button" id="tsOff" class="danger">Turn off</button></div></form><div id="tsCodes"></div><p id="tsMsg" class="error"></p>`;
    const pw=()=>$('#tsPassword').value;
    $('#tsNewCodes').onclick=async()=>{try{const r=await api('/api/me/2fa/backup-codes',{method:'POST',body:JSON.stringify({password:pw()})});$('#tsCodes').innerHTML=backupList(r.backupCodes);wireCopy(r.backupCodes)}catch(x){$('#tsMsg').textContent=x.message}};
    $('#tsOff').onclick=async()=>{if(!await uiConfirm('Turn off two-step sign-in? Signing in will only need your password.',{ok:'Turn off',danger:true}))return;
      try{await api('/api/me/2fa/disable',{method:'POST',body:JSON.stringify({password:pw()})});me.two_factor=0;renderTwoStep()}catch(x){$('#tsMsg').textContent=x.message}};
    return;
  }
  box.innerHTML=`<p class="muted">Off. With it on, signing in also needs a code from an authenticator app on your phone (Google Authenticator, Microsoft Authenticator, 1Password, the iPhone's Passwords app...), so a stolen password alone isn't enough.${me.role==='global_admin'?' <b>Recommended for global admins.</b>':''}</p><button type="button" class="secondary" id="tsStart">Set up two-step sign-in</button><p id="tsMsg" class="error"></p>`;
  $('#tsStart').onclick=async()=>{
    try{
      const [r,qrcode]=await Promise.all([api('/api/me/2fa/setup',{method:'POST',body:'{}'}),loadQr()]);
      const qr=qrcode(0,'M');qr.addData(r.uri);qr.make();
      box.innerHTML=`<ol class="ts-steps"><li>In your authenticator app, add an account and scan this code${/iPhone|iPad|Android/i.test(navigator.userAgent)?`, or <a href="${esc(r.uri)}">open it in the app on this phone</a>`:''}:<div class="qr">${qr.createSvgTag({cellSize:4,margin:2,scalable:true})}</div><p class="muted">Can't scan? Enter this key: <code class="ts-secret">${esc(r.secret.match(/.{1,4}/g).join(' '))}</code></p></li>
        <li><form id="tsEnable"><label>Then type the 6-digit code it shows<input id="tsCode" required inputmode="numeric" autocomplete="one-time-code" maxlength="7"></label><button>Turn on</button></form></li></ol><div id="tsCodes"></div><p id="tsMsg" class="error"></p>`;
      $('#tsEnable').onsubmit=guarded(async()=>{
        try{const on=await api('/api/me/2fa/enable',{method:'POST',body:JSON.stringify({code:$('#tsCode').value})});me.two_factor=1;
          box.innerHTML=`<p><b>Two-step sign-in is on.</b></p>${backupList(on.backupCodes)}`;wireCopy(on.backupCodes)}
        catch(x){$('#tsMsg').textContent=x.message}
      });
    }catch(x){$('#tsMsg').textContent=x.message}
  };
}
function wireCopy(codes){const b=$('#tsCopyCodes');if(b)b.onclick=async()=>{try{await navigator.clipboard.writeText(codes.join('\n'));b.textContent='Copied'}catch(e){uiCopy('Your backup codes:',codes.join(' '))}}}
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
    $('#menuBadge').textContent=n;$('#menuBadge').classList.toggle('hidden',!n);
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
  $('#ticketReplyForm').onsubmit=guarded(async e=>{e.preventDefault();try{await api(`/api/tickets/${id}/comments`,{method:'POST',body:JSON.stringify({body:$('#trBody').value,internal:!!($('#trInternal')&&$('#trInternal').checked)})});await openTicket(id);renderHelp()}catch(x){$('#ticketModalMsg').textContent=x.message}});
  if(admin)$('#ticketAdminForm').onsubmit=guarded(async e=>{e.preventDefault();try{await api(`/api/tickets/${id}`,{method:'PATCH',body:JSON.stringify({status:$('#taStatus').value,resolution:$('#taResolution').value})});await openTicket(id);renderHelp()}catch(x){$('#ticketModalMsg').textContent=x.message}});
  refreshHelpBadge();
}
$('#helpBtn').onclick=showHelp;
$('#helpBack').onclick=()=>showHome();
$('#dashStatus').onchange=()=>{dashFilter.status=$('#dashStatus').value;renderHelp()};
$('#dashType').onchange=()=>{dashFilter.type=$('#dashType').value;renderHelp()};
$('#ticketForm').onsubmit=guarded(async e=>{
  e.preventDefault();
  const file=$('#ticketImage').files[0];
  try{
    const payload={type:$('#ticketType').value,title:$('#ticketTitle').value,description:$('#ticketDesc').value,client_info:`Web · ${navigator.userAgent.slice(0,200)}`};
    if(file)payload.image_url=await uploadImageFile(file,1600,0.85);
    const r=await api('/api/tickets',{method:'POST',body:JSON.stringify(payload)});
    e.target.reset();
    $('#ticketMsg').textContent='';
    $('#modal').close();
    $('#ticketDone').textContent=`Thanks - ticket #${r.id} sent. Replies will appear here.`;
    renderHelp();
  }catch(x){$('#ticketMsg').textContent=x.message}
});
// Checked every two minutes while the page is on screen, and straight away when you come back to it.
setInterval(()=>{if(me&&document.visibilityState==='visible')refreshHelpBadge()},120000);
document.addEventListener('visibilitychange',()=>{if(me&&document.visibilityState==='visible')refreshHelpBadge()});


$('#modalClose').onclick=()=>$('#modal').close();
// Home: the logo and name, and Home in the menu. Signed in, they switch view without reloading the page.
const goHome=e=>{if(!me)return;e.preventDefault();if($('#modal').open)$('#modal').close();showHome()};
$('#brandHome').onclick=goHome;
$('#homeBtn').onclick=goHome;
$('#logout').onclick=async()=>{await api('/api/logout',{method:'POST'});location.reload()};
$('#backHome').onclick=()=>challengeBack==='admin'?showAdmin():showHome();
// Forms in a dialog (logging activity, join with a code, new team, a support ticket) live in a hidden holder and are
// moved into the dialog when their button is pressed, and back when it closes - so their handlers stay put.
function showFormDialog(id){
  $('#modalBody').innerHTML='';
  $('#modalBody').append($('#'+id));
  $('#modal').showModal();
  $('#'+id).querySelector('input:not([type=file]),textarea,select')?.focus();
}
$('#modal').addEventListener('close',()=>{for(const el of $('#modalBody').querySelectorAll('[data-stash]'))$('#dialogStash').append(el)});
$('#joinBtn').onclick=()=>{$('#joinMsg').textContent='';showFormDialog('joinDialog')};
$('#joinForm').onsubmit=guarded(async e=>{e.preventDefault();try{const r=await api('/api/join',{method:'POST',body:JSON.stringify({code:$('#joinCode').value})});$('#joinMsg').textContent='';e.target.reset();$('#modal').close();await loadDashboard();challengeBack='home';await openChallenge(r.challengeId)}catch(x){$('#joinMsg').textContent=x.message}});
// Creating a challenge has a page of its own: a long form (with a map for journeys) that suits phones better than a dialog.
function showNewChallenge(){setUrl('/challenges/new');showView('#newChallengeView');syncNewChallengeKind()}
$('#newChallengeBtn').onclick=showNewChallenge;
$('#newChallengeBack').onclick=()=>showHome();
const newChallengeRte=document.querySelector('#newChallengeForm [data-rte]');
initRichTextEditor(newChallengeRte);
const syncNewChallengeMeasure=wireMeasureFields($('#newChallengeForm'));
// A journey measures distance or steps (a cycling journey, distance), and shows the route picker.
const newChallengeForm=$('#newChallengeForm');
const newJourney=journeyPicker(newChallengeForm.querySelector('[data-journeypicker]'),null,()=>syncNewChallengeKind());
function syncNewChallengeKind(){
  const journey=newChallengeForm.kind.value==='journey',metric=newChallengeForm.querySelector('[data-metric]'),cycling=journey&&newJourney.mode()==='cycling';
  newChallengeForm.querySelector('[data-journeywrap]').classList.toggle('hidden',!journey);
  metric.querySelector('option[value="minutes"]').disabled=journey;
  metric.querySelector('option[value="steps"]').disabled=cycling;
  if((journey&&metric.value==='minutes')||(cycling&&metric.value==='steps'))metric.value='distance';
  syncNewChallengeMeasure();
  if(journey)newJourney.show();
}
newChallengeForm.querySelector('[data-kind]').addEventListener('change',syncNewChallengeKind);
newChallengeForm.onsubmit=guarded(async e=>{
  e.preventDefault();
  $('#newChallengeMsg').textContent='';
  const fields=Object.fromEntries(new FormData(e.target));
  fields.description=newChallengeRte.querySelector('.rte-editor').innerHTML;
  if(fields.kind==='journey'){
    fields.journey=newJourney.value();
    if(!fields.journey){$('#newChallengeMsg').textContent='Choose a start and a finish for the journey.';return}
  }
  let created;
  try{created=await api('/api/challenges',{method:'POST',body:JSON.stringify(fields)})}catch(err){$('#newChallengeMsg').textContent=err.message;return}
  e.target.reset();
  newJourney.reset();
  syncNewChallengeKind();
  newChallengeRte.querySelector('.rte-editor').innerHTML='';
  await loadDashboard();
  challengeBack='home';
  // Back from the new challenge goes home, not to an empty form.
  setUrl('/',true);
  await openChallenge(created.id);
});
$('#newTeamImage').addEventListener('change',()=>{
  const f=$('#newTeamImage').files[0];
  if(!f){$('#newTeamImagePreview').classList.add('hidden');return}
  $('#newTeamImagePreview').src=URL.createObjectURL(f);
  $('#newTeamImagePreview').classList.remove('hidden');
});
$('#newTeamBtn').onclick=()=>showFormDialog('newTeamDialog');
$('#newTicketBtn').onclick=()=>{$('#ticketMsg').textContent='';showFormDialog('ticketDialog')};
$('#newTeamForm').onsubmit=guarded(async e=>{
  // (Also reached from the Teams dialog, which this replaces.)
  e.preventDefault();
  const file=$('#newTeamImage').files[0];
  const payload={challenge_id:curChallenge.id,name:new FormData(e.target).get('name')};
  try{
    if(file)payload.image_url=await uploadImageFile(file,400,0.85);
    await api('/api/teams',{method:'POST',body:JSON.stringify(payload)});
    e.target.reset();
    $('#newTeamImagePreview').classList.add('hidden');
    $('#modal').close();
    await refreshChallenge();
  }catch(err){uiAlert(err.message)}
});
$('#activityDate').value=localToday();
$('#logBtn').onclick=()=>{$('#activityMsg').textContent='';showFormDialog('logDialog')};
$('#startTime').addEventListener('change',()=>{const m=minutesBetween($('#startTime').value,$('#endTime').value);if(m)$('#minutes').value=m});
$('#endTime').addEventListener('change',()=>{const m=minutesBetween($('#startTime').value,$('#endTime').value);if(m)$('#minutes').value=m});
$('#activityForm').onsubmit=guarded(async e=>{
  e.preventDefault();
  const solo=isIndividual(curChallenge),teamId=solo?null:$('#team').value;
  if(!solo&&!teamId){$('#activityMsg').textContent='Join a team first: see Teams in this challenge.';return}
  try{
    // A minutes challenge has no distance box, so a GPX file's distance goes along as extra detail.
    if(isSteps(curChallenge)){
      await api('/api/activities',{method:'POST',body:JSON.stringify({...(solo?{}:{team_id:teamId}),challenge_id:curChallenge.id,activity_type:'Steps',steps:$('#steps').value,activity_date:$('#activityDate').value,comment:$('#activityComment').value})});
      $('#activityMsg').textContent='';e.target.reset();$('#activityDate').value=localToday();
      $('#modal').close();await refreshChallenge();return;
    }
    const dist=isDistance(curChallenge)?{distance:$('#distance').value,distance_unit:$('#distanceUnit').value}:(pendingRoute&&pendingRoute.meters?{distance_m:pendingRoute.meters}:{});
    await api('/api/activities',{method:'POST',body:JSON.stringify({...(solo?{}:{team_id:teamId}),challenge_id:curChallenge.id,activity_type:$('#activityType').value,minutes:$('#minutes').value,...dist,activity_date:$('#activityDate').value,start_time:$('#startTime').value,end_time:$('#endTime').value,comment:$('#activityComment').value,...(pendingRoute?{route:pendingRoute.points}:{})})});
    pendingRoute=null;$('#gpxInfo').classList.add('hidden');
    $('#activityMsg').textContent='';
    const keepUnit=$('#distanceUnit').value;
    e.target.reset();
    $('#distanceUnit').value=keepUnit;
    $('#activityDate').value=localToday();
    $('#modal').close();await refreshChallenge();
  }catch(x){$('#activityMsg').textContent=x.message}
});
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
// Leaflet (OpenStreetMap tiles) is loaded only the first time a map is opened, from this site's own copy.
let leafletReady=null;
function loadLeaflet(){
  if(leafletReady)return leafletReady;
  leafletReady=new Promise((resolve,reject)=>{
    const css=document.createElement('link');css.rel='stylesheet';css.href='/vendor/leaflet-1.9.4/leaflet.css';document.head.appendChild(css);
    const js=document.createElement('script');js.src='/vendor/leaflet-1.9.4/leaflet.js';js.onload=()=>resolve(window.L);js.onerror=()=>{leafletReady=null;reject(Error('Could not load the map library'))};document.head.appendChild(js);
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
    return `<div class="listrow"><div><b>${esc(x.activity_type)}</b><div class="muted">${esc(x.challenge_name)}${x.team_name?` · ${esc(x.team_name)}`:''} · ${esc(fmtDay(x.activity_date))}${x.start_time?` · ${esc(x.start_time)}`:''}</div></div><div class="btnrow"><b>${esc(fmtEntry(c,x))}</b>${x.has_route?`<button class="ghost" data-mymap="${x.id}">Map</button>`:''}</div></div>`;
  }).join('')||'<p class="muted">Nothing logged yet.</p>';
  $('#moreActivity').classList.toggle('hidden',!myActivityMore);
  $all('[data-mymap]').forEach(b=>{const x=myActivity.find(a=>a.id===Number(b.dataset.mymap));b.onclick=()=>openRouteMap(x,{metric:x.metric,distance_unit:x.distance_unit})});
}
$('#moreActivity').onclick=()=>loadMyActivity(true);
async function openRouteMap(x,cc=curChallenge){
  const dlg=$('#modal');
  $('#modalBody').innerHTML=`<h2>${esc(x.activity_type)}</h2><p class="muted">${esc(fmtDay(x.activity_date))}${x.start_time?` · ${esc(x.start_time)}–${esc(x.end_time||'')}`:''} · ${esc(fmtEntry(cc,x))}</p><div id="routeMap" class="route-map"></div><p class="muted">Only you can see this route.</p>`;
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
    if(/^\/challenges\/new\/?$/.test(p))return showNewChallenge();
    if((m=p.match(/^\/challenges\/(\d+)\/?$/)))return await openChallenge(Number(m[1]));
    if((m=p.match(/^\/help\/tickets\/(\d+)\/?$/))){showHelp();setUrl(p,true);return await openTicket(Number(m[1]))}
    if(/^\/help\/?$/.test(p))return showHelp();
    if((m=p.match(/^\/admin(\/challenges|\/log)?\/?$/))&&me.role==='global_admin'){adminTab=m[1]==='/challenges'?'challenges':m[1]==='/log'?'log':'users';return await showAdmin()}
    const code=inviteCodeFromPath();
    if(code)return await openJoinPrompt(code);
    // Arriving at the home page with just one challenge on (or coming up): straight into it. Home is a click away.
    const current=firstRoute&&dash.challenges.filter(c=>c.role!=='admin'&&c.end_date>=localToday());
    if(current&&current.length===1)return await openChallenge(current[0].id);
    showHome();
  }catch(e){showHome();uiAlert(e.message)}
  finally{routing=false;firstRoute=false}
}
let firstRoute=true;
window.addEventListener('popstate',()=>{if(me){if($('#modal').open)$('#modal').close();route()}});
$('#modal').addEventListener('close',()=>{const m=location.pathname.match(/^\/help\/tickets\//);if(m)setUrl('/help',true)});

async function copyInviteLink(code,btn){
  const url=inviteUrl(code);
  try{await navigator.clipboard.writeText(url);const was=btn.textContent;btn.textContent='Link copied';setTimeout(()=>btn.textContent=was,1800)}
  catch(e){uiCopy('Copy this invite link:',url)}
}
// On an Android phone without the app's link handling (or before installing it), offer to open the invite in the app.
const isAndroid=/Android/i.test(navigator.userAgent),isIOS=/iPhone|iPad|iPod/i.test(navigator.userAgent);
const appInviteLink=code=>`intent://join/${encodeURIComponent(code)}#Intent;scheme=activetogether;package=com.activetogether.companion;end`;
function inviteSummary(pv){
  const c=pv.challenge,what=c.metric==='steps'?'steps':c.metric==='distance'?`distance (${c.distance_unit==='km'?'km':'miles'})`:'active minutes';
  const name=pv.team?`the team <b>${esc(pv.team.name)}</b> in <b>${esc(c.name)}</b>`:`<b>${esc(c.name)}</b>`;
  return {name,detail:`${esc(fmtRange(c.start_date,c.end_date))} · measures ${what} · ${c.participation==='individual'?'individuals':'teams'} · ${c.members} member${c.members===1?'':'s'}`};
}
// Signed out on an invite link: say what it's for above the sign-in / register form.
async function showInviteBanner(){
  const code=inviteCodeFromPath(),el=$('#inviteBanner');
  if(!code){el.classList.add('hidden');return}
  try{
    const pv=await api(`/api/join/preview?code=${encodeURIComponent(code)}`),s=inviteSummary(pv);
    el.innerHTML=`<h2>You're invited</h2><p>Join ${s.name}.</p><p class="muted">${s.detail}</p><p>Sign in, or create an account if you're new, and we'll ask you to confirm joining.</p>${isAndroid?`<p><a class="ghost" href="${appInviteLink(code)}">Have the Android app? Open this invite in the app</a></p>`:''}${isIOS?`<p><a class="ghost" href="activetogether://join/${encodeURIComponent(code)}">Have the iPhone app? Open this invite in the app</a></p>`:''}`;
  }catch(e){el.innerHTML=`<h2>Invite link</h2><p class="error">${esc(e.message)}</p><p class="muted">Ask whoever sent it for a new link or code.</p>`}
  el.classList.remove('hidden');
}
// Signed in on an invite link: confirm before joining.
async function openJoinPrompt(code){
  let pv;
  try{pv=await api(`/api/join/preview?code=${encodeURIComponent(code)}`)}catch(e){showHome();uiAlert(e.message);return}
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
