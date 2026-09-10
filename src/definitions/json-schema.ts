import type { JsonValue } from "../domain/json";

export type JsonSchemaType =
  | "null"
  | "boolean"
  | "number"
  | "integer"
  | "string"
  | "array"
  | "object";

export interface JsonSchema {
  $id?: string;
  $ref?: string;
  $defs?: Record<string, JsonSchema>;
  title?: string;
  description?: string;
  type?: JsonSchemaType | JsonSchemaType[];
  const?: JsonValue;
  enum?: JsonValue[];
  oneOf?: JsonSchema[];
  allOf?: JsonSchema[];
  if?: JsonSchema;
  then?: JsonSchema;
  required?: string[];
  properties?: Record<string, JsonSchema>;
  propertyNames?: JsonSchema;
  additionalProperties?: boolean | JsonSchema;
  items?: JsonSchema;
  minItems?: number;
  maxItems?: number;
  uniqueItems?: boolean;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  minimum?: number;
  maximum?: number;
}

export interface SchemaViolation {
  path: string;
  message: string;
}

function sameJson(left: JsonValue, right: JsonValue): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function actualType(value: JsonValue): JsonSchemaType {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number" && Number.isInteger(value)) return "integer";
  return typeof value as JsonSchemaType;
}

function typeMatches(value: JsonValue, expected: JsonSchemaType): boolean {
  if (expected === "number") return typeof value === "number";
  if (expected === "integer") return typeof value === "number" && Number.isInteger(value);
  if (expected === "array") return Array.isArray(value);
  if (expected === "object") {
    return value !== null && typeof value === "object" && !Array.isArray(value);
  }
  if (expected === "null") return value === null;
  return typeof value === expected;
}

export function validateJsonSchema(
  value: JsonValue,
  schema: JsonSchema,
  path = "$"
): SchemaViolation[] {
  return validateJsonSchemaNode(value, schema, path, schema);
}

function resolveLocalReference(schema: JsonSchema, root: JsonSchema): JsonSchema | null {
  if (!schema.$ref) return schema;
  const prefix = "#/$defs/";
  if (!schema.$ref.startsWith(prefix)) return null;
  const key = schema.$ref.slice(prefix.length);
  if (!key || !root.$defs || !Object.prototype.hasOwnProperty.call(root.$defs, key)) return null;
  return root.$defs[key];
}

function validateJsonSchemaNode(
  value: JsonValue,
  schema: JsonSchema,
  path: string,
  root: JsonSchema
): SchemaViolation[] {
  const violations: SchemaViolation[] = [];
  const resolved = resolveLocalReference(schema, root);
  if (!resolved) {
    violations.push({ path, message: `contains an unsupported or unresolved schema reference ${String(schema.$ref)}` });
    return violations;
  }
  if (resolved !== schema) return validateJsonSchemaNode(value, resolved, path, root);

  if (schema.if) {
    const condition = validateJsonSchemaNode(value, schema.if, path, root);
    if (condition.length === 0 && schema.then) {
      violations.push(...validateJsonSchemaNode(value, schema.then, path, root));
    }
  }
  if (schema.allOf) {
    for (const candidate of schema.allOf) {
      violations.push(...validateJsonSchemaNode(value, candidate, path, root));
    }
  }
  if (schema.oneOf) {
    const candidates = schema.oneOf.map((candidate) =>
      validateJsonSchemaNode(value, candidate, path, root)
    );
    if (candidates.filter((candidate) => candidate.length === 0).length !== 1) {
      violations.push({ path, message: "must match exactly one oneOf schema" });
    }
    return violations;
  }
  if (schema.const !== undefined && !sameJson(value, schema.const)) {
    violations.push({ path, message: `must equal ${JSON.stringify(schema.const)}` });
  }
  if (schema.enum && !schema.enum.some((candidate) => sameJson(value, candidate))) {
    violations.push({ path, message: "must be one of the declared enum values" });
  }
  if (schema.type) {
    const expected = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!expected.some((candidate) => typeMatches(value, candidate))) {
      violations.push({
        path,
        message: `must have type ${expected.join("|")}; received ${actualType(value)}`,
      });
      return violations;
    }
  }
  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      violations.push({ path, message: `must contain at least ${schema.minLength} characters` });
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      violations.push({ path, message: `must contain at most ${schema.maxLength} characters` });
    }
    if (schema.pattern !== undefined && !new RegExp(schema.pattern, "u").test(value)) {
      violations.push({ path, message: `must match /${schema.pattern}/` });
    }
  }
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) {
      violations.push({ path, message: `must be >= ${schema.minimum}` });
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      violations.push({ path, message: `must be <= ${schema.maximum}` });
    }
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      violations.push({ path, message: `must contain at least ${schema.minItems} items` });
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      violations.push({ path, message: `must contain at most ${schema.maxItems} items` });
    }
    if (schema.uniqueItems) {
      const serialized = value.map((item) => JSON.stringify(item));
      if (new Set(serialized).size !== serialized.length) {
        violations.push({ path, message: "must contain unique items" });
      }
    }
    if (schema.items) {
      value.forEach((item, index) => {
        violations.push(...validateJsonSchemaNode(item, schema.items!, `${path}[${index}]`, root));
      });
    }
  }
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const properties = schema.properties ?? {};
    for (const key of schema.required ?? []) {
      if (!(key in value)) violations.push({ path: `${path}.${key}`, message: "is required" });
    }
    for (const [key, child] of Object.entries(value)) {
      if (schema.propertyNames) {
        violations.push(...validateJsonSchemaNode(key, schema.propertyNames, `${path}.${key} (property name)`, root));
      }
      const propertySchema = properties[key];
      if (propertySchema) {
        violations.push(...validateJsonSchemaNode(child, propertySchema, `${path}.${key}`, root));
      } else if (schema.additionalProperties === false) {
        violations.push({ path: `${path}.${key}`, message: "is not allowed" });
      } else if (typeof schema.additionalProperties === "object") {
        violations.push(
          ...validateJsonSchemaNode(child, schema.additionalProperties, `${path}.${key}`, root)
        );
      }
    }
  }
  return violations;
}

export function assertJsonSchema(
  value: JsonValue,
  schema: JsonSchema,
  label: string
): void {
  const violations = validateJsonSchema(value, schema);
  if (violations.length === 0) return;
  const detail = violations
    .slice(0, 12)
    .map((violation) => `${violation.path} ${violation.message}`)
    .join("; ");
  throw new Error(`${label} failed schema validation: ${detail}`);
}
