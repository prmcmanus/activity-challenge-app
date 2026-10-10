// The sync page: which store links to show (the Play and App Store listings once they're open to everyone, the direct
// download and TestFlight until then), from the site's settings.
fetch('/api/config').then(r=>r.json()).then(cfg=>{
  const st=cfg.stores||{};
  const show=(name,on)=>document.querySelectorAll(`[data-store="${name}"]`).forEach(el=>{el.hidden=!on});
  show('play-live',!!st.playLive);show('apk',!st.playLive);
  show('appstore',!!st.appStore);show('testflight',!st.appStore);
  document.querySelectorAll('[data-href]').forEach(a=>{const u=st[a.dataset.href];if(u)a.href=u});
}).catch(()=>{});
