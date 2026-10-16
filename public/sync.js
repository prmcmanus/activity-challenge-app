// The sync page: the Google Play and TestFlight (or App Store) links from the site's settings. The website download,
// Apple Shortcuts and installing with Sideloadly are only shown to global admins.
fetch('/api/config').then(r=>r.json()).then(cfg=>{
  const st=cfg.stores||{};
  const show=(name,on)=>document.querySelectorAll(`[data-store="${name}"]`).forEach(el=>{el.hidden=!on});
  show('appstore',!!st.appStore);show('testflight',!st.appStore);show('playlive',!!st.playLive);show('playtest',!st.playLive);
  document.querySelectorAll('[data-href]').forEach(a=>{const u=st[a.dataset.href];if(u)a.href=u});
}).catch(()=>{});
fetch('/api/me').then(r=>r.json()).then(m=>{
  const u=m.user,admin=!!u&&(u.role==='global_admin'||u.admin_needs_two_factor);
  document.querySelectorAll('[data-admin]').forEach(el=>{el.hidden=!admin});
}).catch(()=>{});
