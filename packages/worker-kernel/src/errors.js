/** Programmer/API misuse before a worker run owns resources. */
export class WorkerKernelApiError extends Error {
  /** @param {string} code @param {string} path @param {string} message */
  constructor(code, path, message) {
    super(message);
    this.name = "WorkerKernelApiError";
    this.category = "api";
    this.code = code;
    this.path = path;
  }
}
