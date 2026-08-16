import type { DefinitionRegistries } from "./registries";
import { createDefaultEffectMapperRegistry } from "../tasks/effects/default-effect-mappers";
import { createDefaultGuardrailRegistry } from "../tasks/guardrails/default-guardrails";
import { createDefaultSchemaRegistry } from "../tasks/schemas/default-schemas";

export function createDefaultDefinitionRegistries(): DefinitionRegistries {
  return {
    schemas: createDefaultSchemaRegistry(),
    guardrails: createDefaultGuardrailRegistry(),
    effectMappers: createDefaultEffectMapperRegistry(),
  };
}
