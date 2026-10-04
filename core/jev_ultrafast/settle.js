((quietMs, timeoutMs, minChars) => new Promise(resolve => {
  let t;
  const done = () => { o.disconnect(); resolve(true); };
  const ready = () => (document.body?.innerText ?? '').trim().length >= minChars;
  const arm = () => { clearTimeout(t); t = setTimeout(() => ready() ? done() : arm(), quietMs); };
  let last = document.body?.innerText ?? '';
  const o = new MutationObserver(() => {
    const now = document.body?.innerText ?? '';
    if (now !== last) { last = now; arm(); }
  });
  o.observe(document, {subtree: true, childList: true, characterData: true});
  arm();
  setTimeout(done, timeoutMs);
}))
