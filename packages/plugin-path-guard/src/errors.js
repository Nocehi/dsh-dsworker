/** Typed package errors are programmer/configuration failures, never ordinary policy decisions. */
export class PathGuardError extends Error {
  /**
   * @param {string} category
   * @param {string} code
   * @param {string} path
   * @param {string} message
   * @param {ErrorOptions} [options]
   */
  constructor(category, code, path, message, options) {
    super(message, options);
    this.name = this.constructor.name;
    this.category = category;
    this.code = code;
    this.path = path;
  }
}

export class PathGuardApiError extends PathGuardError {
  /** @param {string} code @param {string} path @param {string} message */
  constructor(code, path, message) {
    super("api", code, path, message);
  }
}

export class PathGuardConfigurationError extends PathGuardError {
  /** @param {string} code @param {string} path @param {string} message */
  constructor(code, path, message) {
    super("configuration", code, path, message);
  }
}
