((quietMs, timeoutMs) => new Promise(resolve => {
  const finish = (timedOut) => {
    if (observer) observer.disconnect();
    resolve({url: location.href, title: document.title, text: document.body?.innerText ?? "", settled: !timedOut});
  };
  let observer = null, timer = null, done = false;
  const complete = () => { if (!done) { done = true; clearTimeout(timer); clearTimeout(cap); finish(false); } };
  const cap = setTimeout(() => { if (!done) { done = true; clearTimeout(timer); finish(true); } }, timeoutMs);
  const arm = () => { clearTimeout(timer); timer = setTimeout(complete, quietMs); };
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
