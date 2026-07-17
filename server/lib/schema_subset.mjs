// Mirror of the backend's dependency-free JSON-schema subset
// (runtime/schema_validation.py). Two jobs:
//   1. checkSchemaSubset — reject schemas that use keywords the backend
//      validator does not implement ($ref, oneOf, pattern, ...).
//   2. validateInstance — validate a value against a subset schema (used by
//      the mock Airflow adapter and tests).

// Exactly the keywords the backend validator implements — nothing more.
const SUPPORTED_KEYWORDS = new Set([
  'type', 'enum', 'required', 'properties', 'additionalProperties',
  'minItems', 'minLength', 'minimum', 'maximum', 'items',
]);

export function checkSchemaSubset(schema, path = 'schema') {
  const problems = [];
  if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) {
    problems.push(`${path}: must be an object`);
    return problems;
  }
  for (const key of Object.keys(schema)) {
    if (!SUPPORTED_KEYWORDS.has(key)) {
      problems.push(`${path}.${key}: unsupported keyword — the runtime validator only supports ${[...SUPPORTED_KEYWORDS].join(', ')}`);
    }
  }
  if ('properties' in schema) {
    if (typeof schema.properties !== 'object' || Array.isArray(schema.properties)) {
      problems.push(`${path}.properties: must be an object`);
    } else {
      for (const [name, sub] of Object.entries(schema.properties)) {
        problems.push(...checkSchemaSubset(sub, `${path}.properties.${name}`));
      }
    }
  }
  if ('items' in schema) problems.push(...checkSchemaSubset(schema.items, `${path}.items`));
  if ('required' in schema && (!Array.isArray(schema.required) || schema.required.some((r) => typeof r !== 'string'))) {
    problems.push(`${path}.required: must be an array of strings`);
  }
  if ('enum' in schema && !Array.isArray(schema.enum)) {
    problems.push(`${path}.enum: must be an array`);
  }
  return problems;
}

function typeMatches(value, type) {
  switch (type) {
    case 'object': return value !== null && typeof value === 'object' && !Array.isArray(value);
    case 'array': return Array.isArray(value);
    case 'string': return typeof value === 'string';
    case 'integer': return Number.isInteger(value);
    case 'number': return typeof value === 'number' && Number.isFinite(value);
    case 'boolean': return typeof value === 'boolean';
    case 'null': return value === null;
    default: return true;
  }
}

export function validateInstance(value, schema, path = '$') {
  const errors = [];
  if (!schema || typeof schema !== 'object') return errors;
  if (schema.type && !typeMatches(value, schema.type)) {
    errors.push(`${path}: expected ${schema.type}`);
    return errors;
  }
  if (schema.enum && !schema.enum.some((e) => e === value)) {
    errors.push(`${path}: must be one of ${JSON.stringify(schema.enum)}`);
  }
  if (typeof value === 'string' && schema.minLength != null && value.length < schema.minLength) {
    errors.push(`${path}: shorter than minLength ${schema.minLength}`);
  }
  if (typeof value === 'number') {
    if (schema.minimum != null && value < schema.minimum) errors.push(`${path}: below minimum ${schema.minimum}`);
    if (schema.maximum != null && value > schema.maximum) errors.push(`${path}: above maximum ${schema.maximum}`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems != null && value.length < schema.minItems) {
      errors.push(`${path}: fewer than minItems ${schema.minItems}`);
    }
    if (schema.items) {
      value.forEach((item, i) => errors.push(...validateInstance(item, schema.items, `${path}[${i}]`)));
    }
  }
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    for (const req of schema.required ?? []) {
      if (!(req in value)) errors.push(`${path}: missing required property "${req}"`);
    }
    const props = schema.properties ?? {};
    for (const [key, sub] of Object.entries(props)) {
      if (key in value) errors.push(...validateInstance(value[key], sub, `${path}.${key}`));
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!(key in props)) errors.push(`${path}: unexpected property "${key}"`);
      }
    }
  }
  return errors;
}
