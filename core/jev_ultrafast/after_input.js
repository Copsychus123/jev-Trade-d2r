(action => new Promise(resolve => {
  const field=window.__jevFast?.nodes.get(action.node);
  const autocomplete=action.kind==='fill' && field?.getAttribute('role')==='combobox';
  let frames=0, stopped=false;
  const settle=action.kind==='click';
  let quietTimer, started=false;
  let last=document.body?.innerText ?? '';
  const observer=new MutationObserver(()=>{
    if (!settle) return;
    const now=document.body?.innerText ?? '';
    if (now!==last) {last=now;started=true;arm();}
  });
  const arm=()=>{clearTimeout(quietTimer);quietTimer=setTimeout(finish,400)};
  const finish=()=>{if (stopped) return;stopped=true;observer.disconnect();resolve()};
  setTimeout(finish,settle ? 6000 : (autocomplete ? 200 : 50));
  if (settle) {
    observer.observe(document,{subtree:true,childList:true,characterData:true,attributes:true});
    setTimeout(()=>{if (!started) {started=true;arm();}},1000);
  }
  const ready=()=>{
    if (stopped || settle) return;
    const ids=(field?.getAttribute('aria-controls')||field?.getAttribute('aria-owns')||'')
      .split(/\s+/).filter(Boolean);
    const roots=ids.length ? ids.map(id=>document.getElementById(id)).filter(Boolean) : [document];
    const options=roots.flatMap(root=>[...root.querySelectorAll('[role="option"]')]);
    if (++frames>=2 && (!autocomplete || options.some(e=>{
      const r=e.getBoundingClientRect();
      return r.width && r.height && r.bottom>0 && r.top<innerHeight &&
        e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true});
    }))) finish();
    else requestAnimationFrame(ready);
  };
  requestAnimationFrame(ready);
}))
