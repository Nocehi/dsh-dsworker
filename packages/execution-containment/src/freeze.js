/** @param {unknown} value */
export function isPlainDataObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** @template T @param {T} value @returns {Readonly<T>} */
export function deepFreeze(value) {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  for (const entry of Object.values(value)) deepFreeze(entry);
  return Object.freeze(value);
}
