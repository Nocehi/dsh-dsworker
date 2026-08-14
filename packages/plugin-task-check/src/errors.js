/** Programmer/configuration misuse at the rc.6 task-check adapter boundary. */
export class TaskCheckPluginError extends Error {
  /**
   * @param {string} message
   * @param {{category: "api" | "configuration", code: string, path: string}} details
   */
  constructor(message, details) {
    super(message);
    this.name = new.target.name;
    this.category = details.category;
    this.code = details.code;
    this.path = details.path;
  }
}

export class TaskCheckPluginApiError extends TaskCheckPluginError {
  /** @param {string} code @param {string} path @param {string} message */
  constructor(code, path, message) {
    super(message, { category: "api", code, path });
  }
}

export class TaskCheckPluginConfigurationError extends TaskCheckPluginError {
  /** @param {string} code @param {string} path @param {string} message */
  constructor(code, path, message) {
    super(message, { category: "configuration", code, path });
  }
}
