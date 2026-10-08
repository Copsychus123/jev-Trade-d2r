((quietMs, timeoutMs, minChars) => new Promise(resolve => {
  let quietTimer, finished = false;
  const started = performance.now();
  // { capped, ms, visibility }: whether the cap ended the wait, how long it took, and the document's visibility.
  // Measurement only (callers may ignore it); visibility is read here so callers need no extra round trip.
  const done = (capped) => {
    if (finished) return;
    finished = true; observer.disconnect();
    resolve({capped, ms: Math.round(performance.now() - started), visibility: document.visibilityState});
  };
  const ready = () => (document.body?.innerText ?? '').trim().length >= minChars;
  const arm = () => { clearTimeout(quietTimer); quietTimer = setTimeout(() => ready() ? done(false) : arm(), quietMs); };
  let last = document.body?.innerText ?? '';
  const observer = new MutationObserver(() => {
    const now = document.body?.innerText ?? '';
    if (now !== last) { last = now; arm(); }
  });
  observer.observe(document, {subtree: true, childList: true, characterData: true});
  arm();
  setTimeout(() => done(true), timeoutMs);
}))
