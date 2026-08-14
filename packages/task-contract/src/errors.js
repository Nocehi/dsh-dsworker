/** Base class for every fail-closed task-contract rejection. */
export class TaskContractError extends Error {
  /**
   * @param {string} message
   * @param {{category: "parse" | "semantic" | "unsupported", code: string, path: string}} details
   */
  constructor(message, details) {
    super(message);
    this.name = new.target.name;
    this.category = details.category;
    this.code = details.code;
    this.path = details.path;
  }
}

/** The input does not have the closed JSON shape required by the schema. */
export class TaskContractParseError extends TaskContractError {
  /** @param {string} code @param {string} path @param {string} message */
  constructor(code, path, message) {
    super(message, { category: "parse", code, path });
  }
}

/** Individually well-shaped fields combine into contradictory authority. */
export class TaskContractSemanticError extends TaskContractError {
  /** @param {string} code @param {string} path @param {string} message */
  constructor(code, path, message) {
    super(message, { category: "semantic", code, path });
  }
}

/** The input asks v1 to represent a feature whose semantics it does not own. */
export class TaskContractUnsupportedError extends TaskContractError {
  /** @param {string} code @param {string} path @param {string} message */
  constructor(code, path, message) {
    super(message, { category: "unsupported", code, path });
  }
}
