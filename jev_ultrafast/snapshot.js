(() => {
  if (!document.body) return null;
  const cache = window.__jevFast ||= {ids:new WeakMap(), nodes:new Map(), next:1};
  const identity = e => {
    if (!cache.ids.has(e)) cache.ids.set(e,cache.next++);
    const id=cache.ids.get(e); cache.nodes.set(id,e); return id;
  };
  for (const [id,e] of cache.nodes) if (!e.isConnected) cache.nodes.delete(id);
  const safe = e => !['password','file','hidden'].includes(e.type);
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
  const scrolls = (el, axis) => {
    const s=getComputedStyle(el), size=axis==='y' ? el.scrollHeight-el.clientHeight : el.scrollWidth-el.clientWidth;
    const overflow=axis==='y' ? s.overflowY : s.overflowX;
    return size>2 && ['auto','scroll','hidden','overlay'].includes(overflow);
  };
  const isFilterControl = e => {
    if (['checkbox','radio','switch'].includes(role(e))) return true;
    const control=e.control;
    return !!control && (['checkbox','radio'].includes(control.type) ||
      ['checkbox','radio','switch'].includes(control.getAttribute('role')));
  };
  cache.visible = e => {
    if (e.closest('[aria-hidden="true"],[inert]')) return false;
    const native=e.tagName==='INPUT' && ['checkbox','radio'].includes(e.type);
    if (e.checkVisibility({checkOpacity:!native, checkVisibilityCSS:true})) return true;
    const r=e.getBoundingClientRect();
    return isFilterControl(e) && r.width>0 && r.height>0;
  };
  const visible = e => cache.visible(e);
  const inView = (e, r=e.getBoundingClientRect()) => {
    const x=r.x+r.width/2, y=r.y+r.height/2;
    if (!(r.width>0 && r.height>0 && x>=0 && y>=0 && x<innerWidth && y<innerHeight)) return false;
    const skipOverflow=isFilterControl(e);
    for (let p=e.parentElement; p && p!==document.documentElement; p=p.parentElement) {
      const clipY=skipOverflow ? false : scrolls(p, 'y') || getComputedStyle(p).overflowY==='hidden';
      const clipX=skipOverflow ? false : scrolls(p, 'x') || getComputedStyle(p).overflowX==='hidden';
      if (clipX || clipY) {
        const pr=p.getBoundingClientRect();
        if ((clipX && (x<pr.left || x>=pr.right)) || (clipY && (y<pr.top || y>=pr.bottom))) return false;
      }
    }
    return true;
  };
  cache.reveal = e => {
    for (let p=e.parentElement; p && p!==document.documentElement; p=p.parentElement) {
      const oy=scrolls(p, 'y'), ox=scrolls(p, 'x');
      if (!oy && !ox) continue;
      const pr=p.getBoundingClientRect(), r=e.getBoundingClientRect();
      const x=r.x+r.width/2, y=r.y+r.height/2;
      if (oy) p.scrollTop += y-(pr.top+pr.height/2);
      if (ox) p.scrollLeft += x-(pr.left+pr.width/2);
    }
  };
  const indexNode = e => {
    const r=e.getBoundingClientRect();
    const native=e.tagName==='INPUT' && ['checkbox','radio'].includes(e.type);
    const x=r.x+r.width/2, y=r.y+r.height/2, hit=document.elementFromPoint(x,y);
    const covered=hit && !e.contains(hit) && [...(e.labels||[])].some(l=>l===hit||l.contains(hit));
    const tiny=r.width<=1 || r.height<=1 || !inView(e, r);
    if (native && (tiny || covered)) {
      return [...(e.labels||[])].find(l=>{
        if (!visible(l)) return false;
        const lr=l.getBoundingClientRect();
        return inView(l, lr) && lr.width>1 && lr.height>1;
      }) || null;
    }
    return inView(e, r) ? e : null;
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
      e.getAttribute('href'),scope?.innerText?.slice(0,6000)||''];
  };
  const actions=[], seen=new Set();
  for (const e of document.querySelectorAll(selector)) {
    if (!safe(e) || !visible(e) || e.matches(':disabled') || e.closest('[aria-disabled="true"]')) continue;
    const rname=role(e), target=indexNode(e);
    if (!rname || !target || seen.has(target)) continue;
    seen.add(target);
    const r=target.getBoundingClientRect();
    if (rname==='gridcell' && e.querySelector('button,[role="button"]')) continue;
    const base={node:identity(target),role:rname,label:name(e)||rname,
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
  const omitted_actions=Math.max(0,actions.length-250);
  actions.splice(250);
  const scrollTitle = e => {
    const host=e?.closest('dialog,[role="dialog"],[role="listbox"],[aria-label]');
    return (host && (host.getAttribute('aria-label') || name(host).trim().split(/\s+/).slice(0,6).join(' '))) || 'page';
  };
  const pushScroll = (el, id) => {
    const top=el ? el.scrollTop : scrollY, client=el ? el.clientHeight : innerHeight;
    const sh=el ? el.scrollHeight : height;
    const more_below=top+client<sh-2, more_above=top>0;
    const title=el ? scrollTitle(el) : 'page';
    const delta=el ? Math.max(48, Math.round(0.85*client)) : 560;
    const base={kind:'scroll', node:id, more_below, more_above};
    if (more_below) actions.push({...base, direction:'down', delta, label:'Scroll down '+title});
    if (more_above) actions.push({...base, direction:'up', delta:-delta, label:'Scroll up '+title});
  };
  pushScroll(null, null);
  for (const e of document.querySelectorAll('*')) {
    if (e===document.documentElement || e===document.body) continue;
    if (scrolls(e, 'y') && visible(e)) pushScroll(e, identity(e));
  }
  const page_key=cache.pageKey(), guards={};
  for (const a of actions)
    if (a.node!=null && !(a.node in guards)) guards[a.node]=cache.guard(cache.nodes.get(a.node));
  // Compare meaning and identity. Geometry is always resolved and hit-tested just before input.
  const semantics=actions.map(({rect,...action})=>action);
  const marker=[performance.timeOrigin,location.href,scrollX,scrollY,innerWidth,innerHeight,
    document.title,text,semantics,page_key[6]];
  actions.forEach((a,i)=>a.id='e'+(i+1));
  actions.push({id:'wait',kind:'wait',label:'Wait for the page to update'});
  return {url:location.href,title:document.title,w:innerWidth,h:innerHeight,text,
    scroll:{y:scrollY,height},actions,marker,page_key,guards,omitted_actions};
})()
