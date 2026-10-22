// Shared error classes. No chrome.* here: these modules must also load under node for tests.

/** A decision no longer refers to the observed page (the page changed). */
export class StalePage extends Error {
  constructor(message = "A decision no longer refers to the observed page.") {
    super(message);
    this.name = "StalePage";
  }
}

/** A wait that never finished (for example a page that never settled). */
export class TimeoutError extends Error {
  constructor(message = "Timed out") {
    super(message);
    this.name = "TimeoutError";
  }
}

/** The user pressed Stop (or the panel closed): the query window was closed under a command that was running. */
export class AbortedError extends Error {
  constructor(message = "查詢已停止") {
    super(message);
    this.name = "AbortedError";
  }
}

/** The backend refused or could not be reached. `status` is 0 for a network failure. */
export class ApiError extends Error {
  constructor(status, message, code = null) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code; // the server's own error code (`invite_used_up`, `too_many_failures`, …), when it sent one
  }
}
