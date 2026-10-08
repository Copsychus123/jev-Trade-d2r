(action => {
  // Measurement only, structural: is the target's centre covered by a full-viewport fixed overlay (a pop-up)?
  // It clicks nothing and names no site element, so the agent keeps working from observation alone.
  const e=window.__jevFast?.nodes.get(action.node);
  if (!e?.isConnected) return false;
  const rect=e.getBoundingClientRect(), x=rect.x+rect.width/2, y=rect.y+rect.height/2;
  if (!rect.width || !rect.height || x<0 || y<0 || x>=innerWidth || y>=innerHeight) return false;
  const hit=document.elementFromPoint(x,y);
  if (!hit || e.contains(hit)) return false;
  // The nearest positioned ancestor is the box the point really lives in: the overlay itself, not the fixed box's parent.
  let box=hit;
  while (box && getComputedStyle(box).position==='static') box=box.parentElement;
  if (!box || getComputedStyle(box).position!=='fixed') return false;
  const cover=box.getBoundingClientRect();
  return cover.width*cover.height >= innerWidth*innerHeight*0.9;
})
