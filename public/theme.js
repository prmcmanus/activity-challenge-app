// Light, dark or the device's own setting ("Auto", the default). Loaded in each page's <head> so the
// choice applies before anything is drawn; the choice is kept on this device. The footer gets the picker.
(function(){
  var KEY='at-theme',root=document.documentElement;
  function saved(){try{return localStorage.getItem(KEY)||'auto'}catch(e){return 'auto'}}
  function apply(t){if(t==='light'||t==='dark')root.setAttribute('data-theme',t);else root.removeAttribute('data-theme')}
  apply(saved());
  document.addEventListener('DOMContentLoaded',function(){
    var footer=document.querySelector('footer');if(!footer)return;
    var pick=document.createElement('span');pick.className='theme-pick';pick.setAttribute('role','group');pick.setAttribute('aria-label','Theme');
    pick.appendChild(document.createTextNode('Theme:'));
    [['auto','Auto'],['light','Light'],['dark','Dark']].forEach(function(o){
      var b=document.createElement('button');b.type='button';b.textContent=o[1];b.dataset.themeChoice=o[0];
      b.title=o[0]==='auto'?"Follow this device's light or dark setting":o[1]+' theme';
      b.onclick=function(){try{if(o[0]==='auto')localStorage.removeItem(KEY);else localStorage.setItem(KEY,o[0])}catch(e){}apply(o[0]);mark()};
      pick.appendChild(b);
    });
    function mark(){var t=saved();pick.querySelectorAll('button').forEach(function(b){b.setAttribute('aria-pressed',String(b.dataset.themeChoice===t))})}
    mark();
    footer.appendChild(document.createTextNode(' · '));footer.appendChild(pick);
  });
})();
