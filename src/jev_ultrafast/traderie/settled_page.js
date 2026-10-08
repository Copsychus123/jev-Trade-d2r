((quietMs, timeoutMs) => new Promise(resolve => {
  let observer = null, quietTimer = null, cap = null, done = false;
  const finish = (timedOut) => {
    if (done) return;
    done = true; clearTimeout(quietTimer); clearTimeout(cap);
    if (observer) observer.disconnect();
    resolve({url: location.href, title: document.title, text: document.body?.innerText ?? "", settled: !timedOut});
  };
  cap = setTimeout(() => finish(true), timeoutMs);
  const arm = () => { clearTimeout(quietTimer); quietTimer = setTimeout(() => finish(false), quietMs); };
  let last = document.body?.innerText ?? "";
  try {
    // Only changes of the visible text restart the quiet period; ad or script churn that adds no text does not.
    observer = new MutationObserver(() => {
      const now = document.body?.innerText ?? "";
      if (now !== last) { last = now; arm(); }
    });
    observer.observe(document.body ?? document.documentElement, {childList: true, subtree: true, characterData: true});
  } catch { observer = null; }
  arm();
}))
