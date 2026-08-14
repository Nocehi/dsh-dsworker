export class WorkspaceDeltaError extends Error {
  /** @param {string} code @param {string} path @param {string} message */
  constructor(code, path, message) {
    super(message);
    this.name = "WorkspaceDeltaError";
    this.category = "workspace-delta";
    this.code = code;
    this.path = path;
  }
}
