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

/** The backend refused or could not be reached. `status` is 0 for a network failure. */
export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}
