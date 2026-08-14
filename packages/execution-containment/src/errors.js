export class ExecutionContainmentError extends Error {
  constructor(message, { category, code, path }) {
    super(message);
    this.name = "ExecutionContainmentError";
    this.category = category;
    this.code = code;
    this.path = path;
  }
}

export class ExecutionContainmentApiError extends ExecutionContainmentError {
  constructor(code, path, message) {
    super(message, { category: "api", code, path });
    this.name = "ExecutionContainmentApiError";
  }
}

export class ExecutionContainmentUnavailableError extends ExecutionContainmentError {
  constructor(code, path, message) {
    super(message, { category: "unavailable", code, path });
    this.name = "ExecutionContainmentUnavailableError";
  }
}

export class ExecutionContainmentExecutionError extends ExecutionContainmentError {
  constructor(code, path, message) {
    super(message, { category: "execution", code, path });
    this.name = "ExecutionContainmentExecutionError";
  }
}
