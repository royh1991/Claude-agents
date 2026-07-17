import { useCatalog } from '../hooks';
import { Markdown, CopyId } from '../components/bits';

export function EnvironmentPage() {
  const { data: catalog, error } = useCatalog();
  if (error) return <div className="alert error">Couldn't load the catalog: {error}</div>;
  if (!catalog) return null;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Environment</h1>
          <div className="sub">
            Where every session runs. One environment exists today; treat it as fixed.
          </div>
        </div>
      </div>

      <div className="grid cols-2">
        {catalog.environments.map((env) => {
          const cfg = (env.config ?? {}) as Record<string, any>;
          return (
            <div className="card" key={env.id}>
              <h2>{String(cfg.name ?? env.id)}</h2>
              <div className="muted small" style={{ marginBottom: 12 }}>{String(cfg.description ?? '')}</div>
              <dl className="kv">
                <dt>Environment ID</dt><dd><CopyId id={env.id} /></dd>
                <dt>Orchestrator</dt><dd>Airflow DAG <span className="mono">{String(cfg.dag_id ?? 'ai-agent-runner')}</span></dd>
                <dt>Compute</dt>
                <dd className="small">
                  KubernetesPodOperator · namespace <span className="mono">{String(cfg.kubernetes?.namespace ?? 'airflow')}</span>
                </dd>
                <dt>Workspace</dt><dd className="mono small">{String(cfg.workspace_root ?? '/workspace')}</dd>
                <dt>Secrets</dt>
                <dd className="small">Vault pod injection — <span className="mono">{String(cfg.secrets?.definition ?? '')}</span></dd>
                <dt>Networking</dt><dd className="small">{String(cfg.networking ?? 'vpc_limited')} — in-VPC services and GitHub only</dd>
              </dl>
            </div>
          );
        })}

        <div className="card">
          <h2>Platform constraints</h2>
          <ul className="result-list small">
            <li><strong>Airflow orchestrates.</strong> Every run is an <span className="mono">ai-agent-runner</span> dag run; there is no separate agent-executing service.</li>
            <li><strong>Kubernetes, in the VPC.</strong> Agent work happens in pods with access to Snowflake, S3, and GitHub through the runtime's bounded tools.</li>
            <li><strong>Vault owns credentials.</strong> Secrets are injected into pods at start; this console stores none and displays none.</li>
            <li><strong>Agents are data.</strong> Config + prompt + schema files — publishing from this console writes YAML for PR review, nothing else.</li>
          </ul>
        </div>
      </div>

      {catalog.guardrails && (
        <div className="card" style={{ marginTop: 16 }}>
          <h2>Shared guardrails — injected into every prompt</h2>
          <Markdown text={catalog.guardrails} />
        </div>
      )}
    </>
  );
}
