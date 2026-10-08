(async (path) => {
  // Same-origin GET the way Traderie's own front end does it: the page's cookies, plus the login token it keeps in
  // localStorage. Read-only; the caller decides what to do with a non-200 answer.
  const jwt = localStorage.getItem("jwt");
  const headers = { Accept: "application/json" };
  if (jwt) headers.Authorization = `Bearer ${jwt}`;
  const response = await fetch(path, { credentials: "include", headers });
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text.slice(0, 300);
  }
  return { status: response.status, body };
})
