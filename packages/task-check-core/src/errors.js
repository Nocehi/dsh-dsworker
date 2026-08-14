/** Programmer/API misuse at the pure task-check authority boundary. */
export class TaskCheckCoreError extends Error {
  /**
   * @param {string} message
   * @param {{code: string, path: string}} details
   */
  constructor(message, details) {
    super(message);
    this.name = new.target.name;
    this.category = "api";
    this.code = details.code;
    this.path = details.path;
  }
}
