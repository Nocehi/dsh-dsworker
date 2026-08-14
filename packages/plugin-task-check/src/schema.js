import { deepFreeze } from "./freeze.js";

const string = () => ({ type: "string" });
const boolean = () => ({ type: "boolean" });
const integer = () => ({ type: "integer" });
const nullableString = () => ({ oneOf: [string(), { type: "null" }] });
const nullableInteger = () => ({ oneOf: [integer(), { type: "null" }] });

/** @param {Record<string, any>} properties */
function closedObject(properties) {
  return {
    type: "object",
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  };
}

const checkpoint = () => closedObject({ ok: boolean(), code: string() });
const commandItem = () =>
  closedObject({
    phase: string(),
    commandId: string(),
    passed: boolean(),
    exitCode: nullableInteger(),
    signal: nullableString(),
    timedOut: boolean(),
    aborted: boolean(),
    failureCode: nullableString(),
  });
const failureItem = () =>
  closedObject({
    category: string(),
    code: string(),
    checkpoint: nullableString(),
    phase: nullableString(),
    commandId: nullableString(),
    path: nullableString(),
  });

export const TASK_CHECK_PARAMETERS_SCHEMA = deepFreeze({
  type: "object",
  properties: {},
  required: [],
  additionalProperties: false,
});

export const TASK_CHECK_OUTPUT_SCHEMA = deepFreeze(
  closedObject({
    version: string(),
    status: { type: "string", enum: ["green", "red", "aborted"] },
    contractSha256: string(),
    workspaceIdentity: string(),
    greenPredicate: closedObject({
      baselineValid: boolean(),
      preCommandSnapshotValid: boolean(),
      postCommandSnapshotValid: boolean(),
      scopeValid: boolean(),
      immutableValid: boolean(),
      allCommandsPresent: boolean(),
      commandsPass: boolean(),
      notAborted: boolean(),
      infrastructureIntact: boolean(),
    }),
    snapshots: closedObject({
      baseline: checkpoint(),
      preCommands: checkpoint(),
      postCommands: checkpoint(),
    }),
    scope: closedObject({
      ok: boolean(),
      preCommandsOk: boolean(),
      postCommandsOk: boolean(),
      preChangedPathCount: integer(),
      postChangedPathCount: integer(),
      preChangedPaths: { type: "array", items: string() },
      postChangedPaths: { type: "array", items: string() },
      preChangedPathsOmitted: integer(),
      postChangedPathsOmitted: integer(),
    }),
    immutable: closedObject({
      ok: boolean(),
      baselineOk: boolean(),
      preCommandsOk: boolean(),
      postCommandsOk: boolean(),
      findingCount: integer(),
    }),
    commands: closedObject({
      total: integer(),
      passed: integer(),
      items: { type: "array", items: commandItem() },
      omitted: integer(),
    }),
    failures: closedObject({
      total: integer(),
      items: { type: "array", items: failureItem() },
      omitted: integer(),
    }),
  }),
);
