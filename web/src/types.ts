export interface ModelRef {
  id: string;
  provider: 'google' | 'anthropic' | 'openai';
}

export interface McpServer {
  name: string;
  url: string;
  tools: string[];
}

export interface Agent {
  id: string;
  type: 'agent';
  name: string;
  description: string | null;
  model: ModelRef;
  system: string | null;
  tools: { type: string; config?: Record<string, boolean> }[];
  mcp_servers: McpServer[];
  skills: unknown[];
  metadata: Record<string, unknown>;
  version: number;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

export interface Credential {
  name: string;
  type: string;
  detail?: string;
}

export interface Environment {
  id: string;
  type: 'environment';
  name: string;
  config: {
    type: string;
    cluster: string | null;
    namespace: string | null;
    network_policy: string;
    credentials: Credential[];
  };
  worker: { status: string; last_seen_at: string | null; worker_id: string | null };
  created_at: string;
  archived_at: string | null;
}

export type SessionStatus = 'queued' | 'running' | 'idle' | 'terminated';

export interface Session {
  id: string;
  type: 'session';
  agent: { id: string; version: number };
  environment_id: string;
  title: string | null;
  status: SessionStatus;
  stop_reason: string | null;
  interrupt_requested: boolean;
  usage: { input_tokens: number; output_tokens: number };
  deployment_run_id: string | null;
  last_error: { type: string; message: string } | null;
  created_at: string;
  updated_at: string;
  last_event_at: string | null;
}

export interface SessionEvent {
  id: string;
  type: string;
  created_at: string;
  content?: { type: string; text: string }[];
  name?: string;
  tool?: string;
  server?: string;
  input?: unknown;
  output?: unknown;
  stop_reason?: string;
  error?: { type: string; message: string; retry_status?: string };
  model?: string;
  model_usage?: { input_tokens: number; output_tokens: number };
  worker_id?: string;
}

export interface Deployment {
  id: string;
  type: 'deployment';
  name: string;
  agent: string;
  environment_id: string;
  initial_events: { type: string; content: { type: string; text: string }[] }[];
  schedule: {
    type: 'cron';
    expression: string;
    timezone: string;
    last_run_at: string | null;
    upcoming_runs_at: string[];
  };
  status: 'active' | 'paused' | 'archived';
  paused_reason: { type: string; error?: { type: string; message: string } } | null;
  created_at: string;
}

export interface DeploymentRun {
  id: string;
  type: 'deployment_run';
  deployment_id: string;
  trigger_context: { type: 'schedule' | 'manual'; scheduled_at?: string };
  session_id: string | null;
  error: { type: string; message: string } | null;
  agent: { type: 'agent'; id: string; version: number } | null;
  created_at: string;
}

export interface ProviderKey {
  id: string;
  provider: 'google' | 'anthropic' | 'openai';
  name: string;
  masked_value: string;
  created_at: string;
  last_used_at: string | null;
}

export interface Overview {
  active_sessions: number;
  sessions_today: number;
  success_rate_7d: number | null;
  session_hours_7d: number;
  agents_count: number;
  deployments_active: number;
  sessions_per_day: { date: string; count: number }[];
  recent_sessions: Session[];
  upcoming_runs: { deployment_id: string; name: string; at: string }[];
}
