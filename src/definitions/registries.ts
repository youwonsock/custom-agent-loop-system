import type { ResolvedAgentDefinition } from "../domain/agent";
import type { DomainEffect } from "../domain/domain-effect";
import type { JsonObject } from "../domain/json";
import type { RunAggregate } from "../domain/run-aggregate";
import type { GuardrailReference, TaskDefinition } from "../domain/task";
import type {
  TaskOutputReference,
  TaskResultEnvelopeV1,
} from "../domain/task-result";
import type { JsonSchema } from "./json-schema";

export class SchemaRegistry {
  private readonly schemas = new Map<string, JsonSchema>();

  register(id: string, schema: JsonSchema): this {
    if (this.schemas.has(id)) throw new Error(`Duplicate schema registry id: ${id}.`);
    this.schemas.set(id, schema);
    return this;
  }

  has(id: string): boolean {
    return this.schemas.has(id);
  }

  get(id: string): JsonSchema {
    const schema = this.schemas.get(id);
    if (!schema) throw new Error(`Unknown schema registry id: ${id}.`);
    return schema;
  }
}

export interface GuardrailContext {
  aggregate: Readonly<RunAggregate>;
  agent: Readonly<ResolvedAgentDefinition>;
  task: Readonly<TaskDefinition>;
  input: Readonly<JsonObject>;
  envelope: Readonly<TaskResultEnvelopeV1>;
  reference: Readonly<GuardrailReference>;
}

export type Guardrail = (context: GuardrailContext) => void | Promise<void>;

export class GuardrailRegistry {
  private readonly guardrails = new Map<string, Guardrail>();

  register(id: string, guardrail: Guardrail): this {
    if (this.guardrails.has(id)) throw new Error(`Duplicate guardrail registry id: ${id}.`);
    this.guardrails.set(id, guardrail);
    return this;
  }

  has(id: string): boolean {
    return this.guardrails.has(id);
  }

  get(id: string): Guardrail {
    const guardrail = this.guardrails.get(id);
    if (!guardrail) throw new Error(`Unknown guardrail registry id: ${id}.`);
    return guardrail;
  }
}

export interface EffectMapperContext {
  aggregate: Readonly<RunAggregate>;
  task: Readonly<TaskDefinition>;
  envelope: Readonly<TaskResultEnvelopeV1>;
  output: Readonly<TaskOutputReference>;
}

export type EffectMapper = (
  context: EffectMapperContext
) => DomainEffect[] | Promise<DomainEffect[]>;

export class EffectMapperRegistry {
  private readonly mappers = new Map<string, EffectMapper>();

  register(id: string, mapper: EffectMapper): this {
    if (this.mappers.has(id)) throw new Error(`Duplicate effect mapper registry id: ${id}.`);
    this.mappers.set(id, mapper);
    return this;
  }

  has(id: string): boolean {
    return this.mappers.has(id);
  }

  get(id: string): EffectMapper {
    const mapper = this.mappers.get(id);
    if (!mapper) throw new Error(`Unknown effect mapper registry id: ${id}.`);
    return mapper;
  }
}

export interface DefinitionRegistries {
  schemas: SchemaRegistry;
  guardrails: GuardrailRegistry;
  effectMappers: EffectMapperRegistry;
}
