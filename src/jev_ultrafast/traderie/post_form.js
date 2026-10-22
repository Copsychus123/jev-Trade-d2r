(async (path, bodyJson) => {
  // Same-origin POST the way Traderie's own front end sends a new listing (measured 2026-10-21, docs/design.md
  // "Listing on Traderie"): a JSON body, the page's cookies, plus the login token it keeps in localStorage. The caller
  // (extension/src/traderie/listing_flow.js) evaluates this exactly once per 上架 and never retries it; `bodyJson` is
  // the already-serialised listing, so this script adds nothing to it.
  const jwt = localStorage.getItem("jwt");
  const headers = { Accept: "application/json", "Content-Type": "application/json" };
  if (jwt) headers.Authorization = `Bearer ${jwt}`;
  const response = await fetch(path, { method: "POST", credentials: "include", headers, body: bodyJson });
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text.slice(0, 300);
  }
  return { status: response.status, body };
})
