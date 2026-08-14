import { appendFile, mkdir } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import { stableStringify } from "./canonical.js";

/** @param {unknown} record */
export function encodeJsonLine(record) {
  return `${stableStringify(record)}\n`;
}

export class JsonlWriter {
  /** @type {Promise<void>} */
  #tail = Promise.resolve();
  /** @type {unknown} */
  #failure;
  /** @type {string} */
  #destination;
  #createdParent = false;

  /** @param {string} destination */
  constructor(destination) {
    if (typeof destination !== "string" || destination.length === 0) {
      throw new TypeError("request-trace destination is required");
    }
    if (!isAbsolute(destination)) {
      throw new TypeError("request-trace destination must be an absolute path");
    }
    this.#destination = destination;
  }

  get destination() {
    return this.#destination;
  }

  /** @param {unknown} record */
  enqueue(record) {
    const line = encodeJsonLine(record);
    this.#tail = this.#tail
      .then(async () => {
        if (!this.#createdParent) {
          await mkdir(dirname(this.#destination), { recursive: true, mode: 0o700 });
          this.#createdParent = true;
        }
        await appendFile(this.#destination, line, { encoding: "utf8", mode: 0o600 });
      })
      .catch((error) => {
        this.#failure ??= error;
      });
  }

  async drain() {
    await this.#tail;
    if (this.#failure !== undefined) throw this.#failure;
  }
}
