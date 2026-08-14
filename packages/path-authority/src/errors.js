/** Base class for programmer misuse and unsupported authority versions. */
export class PathAuthorityError extends Error {
  /**
   * @param {string} message
   * @param {{category: "api" | "unsupported", code: string, path: string}} details
   */
  constructor(message, details) {
    super(message);
    this.name = new.target.name;
    this.category = details.category;
    this.code = details.code;
    this.path = details.path;
  }
}

/** The caller supplied the wrong API shape or a non-TaskContract value. */
export class PathAuthorityApiError extends PathAuthorityError {
  /** @param {string} code @param {string} path @param {string} message */
  constructor(code, path, message) {
    super(message, { category: "api", code, path });
  }
}

/** The input names a genuine or apparent TaskContract version not supported here. */
export class PathAuthorityUnsupportedError extends PathAuthorityError {
  /** @param {string} code @param {string} path @param {string} message */
  constructor(code, path, message) {
    super(message, { category: "unsupported", code, path });
  }
}
