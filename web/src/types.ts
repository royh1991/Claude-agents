// Shapes mirror the backend contract (credible-bi-airflow-triage CLAUDE.md)
// and the console server's /api surface.

export type ModelField = string | { provider?: string; id: string };

export interface AgentConfig {
  type: 'agent';
  id: string;
  version: number;
  name: string;
  description?: string | null;
  model: ModelField;
  system: string;
  tools?: (string | { name: string })[];
  skills?: (string | { skill_id: string })[];
  response_format?: string | null;
  response_formats?: { default?: string; formats?: Record<string, unknown> };
  metadata?: {
    owner_team?: string;
    default_repository_aliases?: string[];
    include_all_repository_aliases_by_default?: boolean;
    notification_defaults?: { type: string; channel?: string }[];
    [key: string]: unknown;
  };
}

export interface CatalogAgent {
  id: string;
  path: string;
  raw: string;
  config: AgentConfig | null;
  parse_error: string | null;
  dir_mismatch: string | null;
}

export interface Skill {
  id: string;
  title: string;
  body: string;
}

export interface SubsetSchema {
  type?: string;
  enum?: unknown[];
  required?: string[];
  properties?: Record<string, SubsetSchema>;
  additionalProperties?: boolean;
  minItems?: number;
  minLength?: number;
  minimum?: number;
  maximum?: number;
  items?: SubsetSchema;
  description?: string;
  default?: unknown;
}

export interface Tool {
  name: string;
  description: string;
  permission_policy: { type: string } | null;
  input_schema: SubsetSchema | null;
  parse_error: string | null;
}

export interface ResponseFormat {
  name: string;
  schema: SubsetSchema | null;
  raw: string;
  parse_error: string | null;
}

export interface EnvironmentDoc {
  id: string;
  config: Record<string, unknown> | null;
  raw: string;
  parse_error: string | null;
}

export interface TriggerDoc {
  id: string;
  config: Record<string, unknown> | null;
  raw: string;
  parse_error: string | null;
}

export interface Catalog {
  backend: {
    repo_root: string;
    package_dir: string;
    using_fixture: boolean;
    package_exists: boolean;
  };
  agents: CatalogAgent[];
  skills: Skill[];
  tools: Tool[];
  response_formats: ResponseFormat[];
  environments: EnvironmentDoc[];
  triggers: TriggerDoc[];
  guardrails: string | null;
  run_mode: 'mock' | 'airflow';
  result_statuses: string[];
}

// ---- runs

export interface SessionEnvelope {
  type: 'session';
  agent: { type?: 'agent'; id: string; version?: number };
  environment_id?: string;
  title?: string | null;
  resources?: ({ type: 'repository_alias'; alias: string } | { type: 'dbt_artifacts'; [k: string]: unknown })[];
  metadata?: Record<string, unknown>;
  events: { type: 'user.message'; content: { type: 'text'; text: string }[] }[];
  response_format?: string;
  notifications?: { type: string }[];
}

export type RunState = 'queued' | 'running' | 'success' | 'failed';

export interface RunSummary {
  dag_run_id: string;
  state: RunState;
  agent_id: string | null;
  title: string | null;
  response_format: string | null;
  logical_date: string | null;
  start_date: string | null;
  end_date: string | null;
  conf: Partial<SessionEnvelope> & Record<string, unknown>;
}

export interface TaskInstance {
  task_id: string;
  state: string | null;
  start_date: string | null;
  end_date: string | null;
  try_number: number;
}

export type ResultStatus =
  | 'success' | 'invalid_input' | 'resource_error'
  | 'provider_error' | 'invalid_output' | 'runtime_error';

export interface ResultEnvelope {
  agent_id: string;
  agent_name: string;
  status: ResultStatus;
  result: Record<string, unknown> | null;
  error: { code: string; message: string } | null;
  raw_output: string;
  session_id: string;
  environment_id: string;
  agent_version: number;
  resource_context: { workspace_root: string; repositories: { alias: string; path: string }[] } | null;
  provider: { kind: string };
}

export interface RunDetail {
  run: RunSummary;
  tasks: TaskInstance[];
  result: ResultEnvelope | null;
  mode: 'mock' | 'airflow';
}

export interface OverviewData {
  agents_count: number;
  skills_count: number;
  tools_count: number;
  response_formats_count: number;
  triggers_count: number;
  runs_7d: number;
  green_rate_7d: number | null;
  active_runs: number;
  recent_runs: RunSummary[];
  run_mode: 'mock' | 'airflow';
  runs_error: string | null;
  backend: Catalog['backend'];
}

// ---- authoring

export interface AgentPreview {
  yaml: string | null;
  problems: string[];
  warnings: string[];
  exists: boolean;
  existing_version: number | null;
}

export interface PublishResult {
  path: string;
  yaml: string;
  previous_yaml: string | null;
  warnings?: string[];
  next_steps: string;
}

export type TriggerFireKind = 'dag_complete' | 'asset_updated' | 'schedule' | 'manual';

export interface TriggerConfig {
  type: 'trigger';
  id: string;
  description?: string;
  agent: { id: string; version?: number };
  fire: {
    when: TriggerFireKind;
    dag_id?: string;
    states?: ('success' | 'failed')[];
    assets?: string[];
    schedule?: { cron: string; timezone: string };
  };
  only_if?: { type: 'dbt_failed_nodes'; present: boolean }[];
  request: {
    title?: string;
    response_format?: string;
    resources?: { type: 'repository_alias'; alias: string }[];
    metadata?: Record<string, unknown>;
    message: string;
  };
  notifications?: { type: string }[];
}

export function modelId(model: ModelField | undefined | null): string {
  if (!model) return '—';
  return typeof model === 'string' ? model : model.id;
}

export function toolName(tool: string | { name: string }): string {
  return typeof tool === 'string' ? tool : tool.name;
}

export function skillId(skill: string | { skill_id: string }): string {
  return typeof skill === 'string' ? skill : skill.skill_id;
}
