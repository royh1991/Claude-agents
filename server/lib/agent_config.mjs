// Validation + canonical YAML generation for agent.yaml and trigger YAML.
// The validation rules mirror the backend's normalize_yaml_agent_config
// (runtime/managed/agents.py) — the backend is the source of truth; when in
// doubt, be at least as strict as it is.
import YAML from 'yaml';
import { AGENT_ID_PATTERN } from './catalog.mjs';
import { checkSchemaSubset } from './schema_subset.mjs';

const KNOWN_METADATA_KEYS = new Set([
  'owner_team', 'default_repository_aliases',
  'include_all_repository_aliases_by_default', 'notification_defaults',
]);

export function validateAgentConfig(config, catalog) {
  const problems = [];
  const warnings = [];
  if (!config || typeof config !== 'object') {
    return { problems: ['config must be an object'], warnings };
  }

  if (config.type !== 'agent') problems.push('type: must be "agent"');
  if (typeof config.id !== 'string' || !AGENT_ID_PATTERN.test(config.id)) {
    problems.push('id: must match ^[a-z][a-z0-9-]{2,80}$ (lowercase, digits, hyphens)');
  }
  if (!Number.isInteger(config.version) || config.version < 1) {
    problems.push('version: must be an integer >= 1');
  }
  if (typeof config.name !== 'string' || !config.name.trim()) {
    problems.push('name: required');
  }
  if (config.description != null && typeof config.description !== 'string') {
    problems.push('description: must be a string');
  }

  // model: string shorthand or {provider, id}
  if (typeof config.model === 'string') {
    if (!config.model.trim()) problems.push('model: required');
  } else if (config.model && typeof config.model === 'object') {
    if (typeof config.model.id !== 'string' || !config.model.id.trim()) {
      problems.push('model.id: required when model is an object');
    }
  } else {
    problems.push('model: required (string id or {provider, id})');
  }

  if (typeof config.system !== 'string' || !config.system.trim()) {
    problems.push('system: required — plain business-readable instructions');
  } else {
    if (/__[A-Z_]+__/.test(config.system)) {
      warnings.push('system: contains legacy __TOKEN__ placeholders; the runtime injects context automatically — new prompts should be plain instructions');
    }
    if (/\{\{\s*dag_run|dag_run\.conf/.test(config.system)) {
      warnings.push('system: looks like it embeds run payloads; put run context in the request metadata instead');
    }
  }

  // The checked-in packs (and the backend contract) use plain strings for
  // both lists; object forms would be emitted verbatim into agent.yaml and
  // misread by the backend, so reject them outright.
  const knownTools = new Set((catalog?.tools ?? []).map((t) => t.name));
  for (const tool of config.tools ?? []) {
    if (typeof tool !== 'string') {
      problems.push('tools: entries must be plain handler-name strings');
    } else if (!knownTools.has(tool)) {
      problems.push(`tools: "${tool}" is not a supported tool handler (available: ${[...knownTools].join(', ') || 'none'})`);
    }
  }

  const knownSkills = new Set((catalog?.skills ?? []).map((s) => s.id));
  for (const skill of config.skills ?? []) {
    if (typeof skill !== 'string') {
      problems.push('skills: entries must be plain skill-stem strings');
    } else if (!knownSkills.has(skill)) {
      problems.push(`skills: "${skill}" not found in skills/ (available: ${[...knownSkills].join(', ') || 'none'})`);
    }
  }

  const knownFormats = new Set((catalog?.response_formats ?? []).map((f) => f.name));
  const inlineFormats = config.response_formats?.formats ?? {};
  if (config.response_format != null) {
    if (typeof config.response_format !== 'string') {
      problems.push('response_format: must be a string naming a response format');
    } else if (!knownFormats.has(config.response_format) && !Object.hasOwn(inlineFormats, config.response_format)) {
      problems.push(`response_format: "${config.response_format}" not found in response_formats/ (available: ${[...knownFormats].join(', ')})`);
    }
  }
  for (const [name, format] of Object.entries(inlineFormats)) {
    const schema = format?.schema ?? format;
    checkSchemaSubset(schema, `response_formats.formats.${name}`).forEach((p) => problems.push(p));
  }
  if (!config.response_format && Object.keys(inlineFormats).length === 0) {
    warnings.push('no response_format set — the run result will fall back to the agent output schema or free JSON; setting one explicitly is strongly recommended');
  }

  const metadata = config.metadata ?? {};
  if (typeof metadata !== 'object' || Array.isArray(metadata)) {
    problems.push('metadata: must be an object');
  } else {
    for (const key of Object.keys(metadata)) {
      if (!KNOWN_METADATA_KEYS.has(key)) {
        warnings.push(`metadata.${key}: not a key the runtime interprets (kept as free-form metadata)`);
      }
    }
    const aliases = metadata.default_repository_aliases;
    if (aliases != null && (!Array.isArray(aliases) || aliases.some((a) => typeof a !== 'string'))) {
      problems.push('metadata.default_repository_aliases: must be a list of repository alias strings');
    }
    if (metadata.include_all_repository_aliases_by_default != null
      && typeof metadata.include_all_repository_aliases_by_default !== 'boolean') {
      problems.push('metadata.include_all_repository_aliases_by_default: must be true or false');
    }
    const notif = metadata.notification_defaults;
    if (notif != null && (!Array.isArray(notif) || notif.some((n) => !n || typeof n !== 'object' || typeof n.type !== 'string'))) {
      problems.push('metadata.notification_defaults: must be a list of objects with a "type"');
    }
  }

  return { problems, warnings };
}

// Canonical agent.yaml: stable key order, block-literal system prompt.
export function generateAgentYaml(config) {
  const doc = {};
  doc.type = 'agent';
  doc.id = config.id;
  doc.version = config.version;
  doc.name = config.name;
  if (config.description) doc.description = config.description;
  doc.model = config.model;
  doc.system = (config.system ?? '').replace(/\s+$/, '') + '\n';
  if (config.tools?.length) doc.tools = config.tools;
  if (config.skills?.length) doc.skills = config.skills;
  if (config.response_format) doc.response_format = config.response_format;
  if (config.response_formats && Object.keys(config.response_formats.formats ?? {}).length) {
    doc.response_formats = config.response_formats;
  }
  if (config.metadata && Object.keys(config.metadata).length) doc.metadata = config.metadata;
  return YAML.stringify(doc, { lineWidth: 96, blockQuote: 'literal' });
}

// ---- Trigger YAML (declarative; see docs/DESIGN.md — the exact shape is a
// proposal pending managed_agent_frontend.md and is versioned so the backend
// can evolve it).

export function validateTriggerConfig(config, catalog) {
  const problems = [];
  if (!config || typeof config !== 'object') return { problems: ['config must be an object'] };
  if (config.type !== 'trigger') problems.push('type: must be "trigger"');
  if (typeof config.id !== 'string' || !AGENT_ID_PATTERN.test(config.id)) {
    problems.push('id: must match ^[a-z][a-z0-9-]{2,80}$');
  }
  const agentIds = new Set((catalog?.agents ?? []).map((a) => a.id));
  if (!config.agent?.id || !agentIds.has(config.agent.id)) {
    problems.push(`agent.id: must reference an existing agent (${[...agentIds].join(', ') || 'none found'})`);
  }
  const source = config.source ?? {};
  const events = new Set(['on_failure', 'on_success', 'schedule', 'manual']);
  if (!events.has(source.event)) {
    problems.push(`source.event: must be one of ${[...events].join(', ')}`);
  }
  if (source.event === 'schedule') {
    if (!source.schedule?.cron) problems.push('source.schedule.cron: required for schedule triggers');
  } else if (source.event !== 'manual' && !source.dag_id) {
    problems.push('source.dag_id: required for on_failure / on_success triggers');
  }
  const request = config.request ?? {};
  if (!request.message || typeof request.message !== 'string' || !request.message.trim()) {
    problems.push('request.message: required — the user.message text each firing sends');
  }
  const formats = new Set((catalog?.response_formats ?? []).map((f) => f.name));
  if (request.response_format && !formats.has(request.response_format)) {
    problems.push(`request.response_format: "${request.response_format}" not found in response_formats/`);
  }
  for (const resource of request.resources ?? []) {
    if (resource?.type === 'repository_alias') {
      if (!resource.alias) problems.push('request.resources: repository_alias entries need an "alias"');
    } else if (resource?.type !== 'dbt_artifacts') {
      problems.push(`request.resources: unsupported resource type "${resource?.type}"`);
    }
  }
  return { problems };
}

export function generateTriggerYaml(config) {
  const doc = {
    type: 'trigger',
    schema_version: 1,
    id: config.id,
  };
  if (config.description) doc.description = config.description;
  doc.agent = { id: config.agent.id };
  if (config.agent.version != null) doc.agent.version = config.agent.version;
  doc.source = config.source;
  doc.request = {};
  if (config.request.title) doc.request.title = config.request.title;
  if (config.request.response_format) doc.request.response_format = config.request.response_format;
  if (config.request.resources?.length) doc.request.resources = config.request.resources;
  if (config.request.metadata && Object.keys(config.request.metadata).length) {
    doc.request.metadata = config.request.metadata;
  }
  doc.request.message = (config.request.message ?? '').replace(/\s+$/, '') + '\n';
  if (config.notifications?.length) doc.notifications = config.notifications;
  return YAML.stringify(doc, { lineWidth: 96, blockQuote: 'literal' });
}
