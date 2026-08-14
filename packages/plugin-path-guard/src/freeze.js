/** @template T @param {T} value @param {WeakSet<object>} [seen] @returns {Readonly<T>} */
export function deepFreeze(value, seen = new WeakSet()) {
  if (
    value === null ||
    (typeof value !== "object" && typeof value !== "function") ||
    seen.has(value)
  ) {
    return /** @type {Readonly<T>} */ (value);
  }
  seen.add(value);
  for (const key of Reflect.ownKeys(value)) deepFreeze(value[key], seen);
  return Object.freeze(value);
}

/** @param {unknown} value */
export function isPlainDataObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  if (Object.getOwnPropertySymbols(value).length !== 0) return false;
  for (const key of Object.getOwnPropertyNames(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      descriptor === undefined ||
      !descriptor.enumerable ||
      !("value" in descriptor)
    ) {
      return false;
    }
  }
  return true;
}
