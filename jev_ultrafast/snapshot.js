(() => {
  if (!document.body) return null;
  const cache = window.__jevFast ||= {ids:new WeakMap(), nodes:new Map(), next:1};
  const identity = e => {
    if (!cache.ids.has(e)) cache.ids.set(e,cache.next++);
    const id=cache.ids.get(e); cache.nodes.set(id,e); return id;
  };
  for (const [id,e] of cache.nodes) if (!e.isConnected) cache.nodes.delete(id);
  const safe = e => !['password','file','hidden'].includes(e.type);
  const visible = e => !e.closest('[aria-hidden="true"],[inert]') &&
    e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true});
  const name = (e,seen=new Set()) => {
    if (!e || seen.has(e)) return '';
    seen.add(e);
    const referenced=(e.getAttribute('aria-labelledby')||'').split(/\s+/)
      .map(id=>name(document.getElementById(id),seen)).filter(Boolean).join(' ');
    return referenced || e.getAttribute('aria-label') ||
      [...(e.labels||[])].map(l=>name(l,seen)).filter(Boolean).join(' ') ||
      (['button','submit','reset'].includes(e.type) ? e.value : '') || e.getAttribute('alt') ||
      (e.tagName==='INPUT' ? '' : [...e.childNodes].map(n=>n.nodeType===3 ? n.textContent :
        n.nodeType===1 && n.getAttribute('aria-hidden')!=='true' ? name(n,seen) : '').join(' ').trim()) ||
      e.getAttribute('title') || e.getAttribute('placeholder') || '';
  };
  const roles=['button','link','checkbox','radio','switch','tab','menuitem','menuitemradio',
    'option','gridcell','combobox','textbox','searchbox','spinbutton'];
  const selector='a[href],button,input,textarea,select,summary,[contenteditable="true"],'+
    roles.map(role=>'[role="'+role+'"]').join(',');
  const role = e => {
    const explicit=e.getAttribute('role');
    if (roles.includes(explicit)) return explicit;
    if (e.tagName==='BUTTON' || e.tagName==='SUMMARY') return 'button';
    if (e.tagName==='A') return 'link';
    if (e.tagName==='SELECT') return 'combobox';
    if (e.tagName==='TEXTAREA' || e.isContentEditable) return 'textbox';
    if (e.tagName==='INPUT') {
      if (['checkbox','radio'].includes(e.type)) return e.type;
      if (['button','submit','reset','image'].includes(e.type)) return 'button';
      if (e.type==='search') return 'searchbox';
      if (e.type==='number') return 'spinbutton';
      if (['text','email','url','tel'].includes(e.type)) return 'textbox';
    }
    return null;
  };
  cache.pageKey=()=>[performance.timeOrigin,location.href,scrollX,scrollY,innerWidth,innerHeight,
    [...document.querySelectorAll('input,textarea,select')].filter(safe)
      .map(e=>[identity(e),e.value,e.checked,e.selectedIndex,e.disabled,e.readOnly])];
  cache.guard=e=>{
    if (!e?.isConnected || !visible(e)) return null;
    const scope=e.closest('form,dialog,[role="dialog"],article,li,tr,[role="row"]') || e.parentElement;
    return [identity(e),role(e),name(e),e.value??null,e.checked??null,e.selectedIndex??null,
      e.readOnly??null,e.matches(':disabled'),e.getAttribute('aria-disabled'),
      e.getAttribute('aria-expanded'),e.getAttribute('aria-checked'),e.getAttribute('aria-selected'),
      e.getAttribute('aria-pressed'),
      e.getAttribute('href'),scope?.innerText?.slice(0,6000)||''];
  };
  const actions=[];
  for (const e of document.querySelectorAll(selector)) {
    if (!safe(e) || !visible(e) || e.matches(':disabled') || e.closest('[aria-disabled="true"]')) continue;
    const r=e.getBoundingClientRect(), x=r.x+r.width/2, y=r.y+r.height/2, rname=role(e);
    if (!rname || r.width<=0 || r.height<=0 || x<0 || y<0 || x>=innerWidth || y>=innerHeight) continue;
    if (rname==='gridcell' && e.querySelector('button,[role="button"]')) continue;
    const base={node:identity(e),role:rname,label:name(e)||rname,
      rect:{x:r.x,y:r.y,w:r.width,h:r.height}};
    for (const key of ['checked','selected','expanded']) {
      const value=e.getAttribute('aria-'+key);
      if (value!==null) base[key]=value;
    }
    if (['checkbox','radio'].includes(e.type)) base.checked=String(e.checked);
    if (e.tagName==='SELECT') {
      for (const o of e.options) if (!o.selected && !o.disabled && !o.closest('optgroup[disabled]'))
        actions.push({...base,kind:'select',value:o.value,
          current_value:[...e.selectedOptions].map(o=>o.label).join(', '),label:base.label+' → '+o.label});
    } else {
      const editable=!e.readOnly && e.getAttribute('aria-readonly')!=='true' &&
        (['textbox','searchbox','spinbutton'].includes(rname) ||
          (rname==='combobox' && ['INPUT','TEXTAREA'].includes(e.tagName)));
      const value='value' in e ? String(e.value) :
        e.isContentEditable || rname==='combobox' ? e.innerText.trim() : '';
      actions.push({...base,kind:editable?'fill':'click',value});
      if (editable) actions.push({...base,kind:'click',value,label:'Open '+base.label});
    }
  }
  // Icon-only affordances. Component libraries wire up <div>/<span> + <svg> (or an icon-font
  // glyph) with a click handler but no role, no prose and often no overlay/list context, so the
  // table above never sees them and the policy can only answer BLOCKED. Admit them on icon
  // evidence alone, innermost candidate per subtree, and only while the table has room — the
  // scan itself is skipped, not just the additions, once the 250-action cap is reached.
  // Locals are kept unique so this block can land next to the other clickable passes (#22/#24)
  // in either order without redeclaring theirs. The :has() scope keeps the scan off the bulk of
  // a content-heavy page; it needs Chrome 105+.
  const budget=Math.min(40,Math.max(0,250-actions.length));
  if (budget) {
    const ICON_PROSE_LIMIT=12, ICON_SCAN_CAP=120;
    const GENERIC_ICON_TOKENS=new Set(['solid','regular','light','thin','duotone','brands','fw','lg','sm',
      'xs','2x','3x','4x','5x','spin','pulse','fixed','width','rotate','flip','stack','inverse','only',
      'icon','icons','glyph','svg','img','anticon','ruyi','el','fa','bi','mdi']);
    const iconToken=(...classNames)=>{
      for (const classList of classNames) for (const name of String(classList||'').split(/\s+/)) {
        const parts=name.split('-').filter(Boolean);
        const last=parts.length>1 ? parts[parts.length-1].toLowerCase() : '';
        if (last.length>=3 && !GENERIC_ICON_TOKENS.has(last) && !/^\d/.test(last)) return last;
      }
      return '';
    };
    // First non-empty evidence wins, across every asset: a decorative leading icon must not hide
    // the one that names the control.
    const iconEvidence=e=>{
      const assets=[...e.querySelectorAll('svg,img,i,em,b')].slice(0,8);
      const values=[e.getAttribute('aria-label'), e.getAttribute('title')];
      for (const asset of assets) values.push(asset.querySelector('title')?.textContent,
        asset.getAttribute('aria-label'), asset.getAttribute('alt'), asset.id);
      values.push(iconToken(e.className, ...assets.map(asset=>asset.className)));
      for (const value of values) { const text=String(value||'').trim(); if (text) return text.slice(0,120); }
      return '';
    };
    const indexedAncestor=e=>{
      for (let parent=e.parentElement; parent; parent=parent.parentElement) {
        const id=cache.ids.get(parent);
        if (id!==undefined && iconSeen.has(id)) return true;
      }
      return false;
    };
    // Prose is measured on the element's own text, never on its accessible name: a long
    // aria-label still describes an icon control, while a text-bearing row belongs to the
    // overlay/list pass. Own text keeps the check cheap, at the cost of counting sr-only spans.
    const iconScope=':is(div,span,li,td,dd,p,section,label,article)';
    const iconSeen=new Set(actions.map(a=>a.node)), iconCandidates=[];
    for (const e of document.querySelectorAll(iconScope+':has(svg,img,i,em,b),[class*="icon"],[class*="Icon"]')) {
      if (iconCandidates.length>=ICON_SCAN_CAP) break;
      if (getComputedStyle(e).cursor!=='pointer' || e.closest('svg')) continue;
      if (!visible(e) || e.matches(':disabled') || e.closest('[aria-disabled="true"],[inert]')) continue;
      if (e.querySelector(selector) || e.textContent.trim().length>ICON_PROSE_LIMIT || indexedAncestor(e)) continue;
      const r=e.getBoundingClientRect(), x=r.x+r.width/2, y=r.y+r.height/2;
      if (r.width<=0 || r.height<=0 || x<0 || y<0 || x>=innerWidth || y>=innerHeight) continue;
      const label=iconEvidence(e), node=identity(e);
      if (!label || iconSeen.has(node)) continue;
      iconCandidates.push({element:e,node,label,rect:{x:r.x,y:r.y,w:r.width,h:r.height}});
    }
    // Innermost per subtree, without the O(n²) contains() scan over every pair.
    const nested=new Set(iconCandidates.map(c=>c.element)), outer=new Set();
    for (const c of iconCandidates) {
      for (let parent=c.element.parentElement; parent; parent=parent.parentElement) {
        if (nested.has(parent)) outer.add(parent);
      }
    }
    let added=0;
    for (const c of iconCandidates) {
      if (added>=budget || outer.has(c.element)) continue;
      const action={node:c.node,role:'button',kind:'click',label:c.label,rect:c.rect,value:''};
      const pressed=c.element.getAttribute('aria-pressed');
      if (pressed!==null) action.pressed=pressed;
      actions.push(action);
      added++;
    }
  }
  const words=[], walker=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT);
  const range=document.createRange(); let node,length=0;
  while ((node=walker.nextNode()) && length<6000) {
    const value=node.textContent.trim(), parent=node.parentElement;
    if (!value || !parent || parent.closest('script,style,noscript,template') || !visible(parent)) continue;
    range.selectNodeContents(node); const r=range.getBoundingClientRect();
    if (r.width>0 && r.height>0 && r.bottom>0 && r.top<innerHeight && r.right>0 && r.left<innerWidth) {
      words.push(value); length+=value.length;
    }
  }
  const text=words.join('\n').slice(0,6000), height=document.documentElement.scrollHeight;
  const page_key=cache.pageKey(), guards={};
  for (const a of actions) if (!(a.node in guards)) guards[a.node]=cache.guard(cache.nodes.get(a.node));
  // Compare meaning and identity. Geometry is always resolved and hit-tested just before input.
  const semantics=actions.map(({rect,...action})=>action);
  const marker=[performance.timeOrigin,location.href,scrollX,scrollY,innerWidth,innerHeight,
    document.title,text,semantics,page_key[6]];
  const omitted_actions=Math.max(0,actions.length-250);
  actions.splice(250);
  actions.forEach((a,i)=>a.id='e'+(i+1));
  if (scrollY+innerHeight<height-2) actions.push({id:'scroll_down',kind:'scroll',label:'Scroll down',delta:560});
  if (scrollY>0) actions.push({id:'scroll_up',kind:'scroll',label:'Scroll up',delta:-560});
  actions.push({id:'wait',kind:'wait',label:'Wait for the page to update'});
  return {url:location.href,title:document.title,w:innerWidth,h:innerHeight,text,
    scroll:{y:scrollY,height},actions,marker,page_key,guards,omitted_actions};
})()
