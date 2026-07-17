import { useCatalog } from '../hooks';
import { Markdown, SchemaTable } from '../components/bits';

export function Library() {
  const { data: catalog, error } = useCatalog();
  if (error) return <div className="alert error">Couldn't load the catalog: {error}</div>;
  if (!catalog) return null;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Library</h1>
          <div className="sub">
            The shared building blocks agents compose: skills (domain judgment), tools
            (sandboxed actions), and response formats (output contracts).
          </div>
        </div>
      </div>

      <div className="card">
        <h2>Skills — skills/*.md</h2>
        <div className="muted small" style={{ marginBottom: 10 }}>
          Injected verbatim into the prompt of any agent that references them.
          Editing a skill changes every agent that uses it.
        </div>
        {catalog.skills.map((skill) => (
          <details key={skill.id} id={`skill-${skill.id}`} className="lib-item">
            <summary>
              <span className="mono">{skill.id}</span>
              <span className="muted small">{skill.title.replace(/^Skill:\s*/i, '')}</span>
            </summary>
            <div style={{ padding: '10px 4px 4px' }}>
              <Markdown text={skill.body} />
            </div>
          </details>
        ))}
      </div>

      <div className="card">
        <h2>Tools — tools/*.yaml</h2>
        <div className="muted small" style={{ marginBottom: 10 }}>
          The only actions an agent can take besides reading its prompt context.
          All are read-only and bounded; adding a new tool <em>type</em> is a backend code change.
        </div>
        {catalog.tools.map((tool) => (
          <details key={tool.name} id={`tool-${tool.name}`} className="lib-item">
            <summary>
              <span className="mono">{tool.name}</span>
              <span className="muted small">{tool.description.split('\n')[0]}</span>
            </summary>
            <div style={{ padding: '10px 4px 4px' }}>
              <Markdown text={tool.description} />
              <div className="io-label muted small" style={{ margin: '10px 0 6px', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Input schema</div>
              <SchemaTable schema={tool.input_schema} />
            </div>
          </details>
        ))}
      </div>

      <div className="card">
        <h2>Response formats — response_formats/*.yaml</h2>
        <div className="muted small" style={{ marginBottom: 10 }}>
          Structured output contracts. The runtime injects the schema into the prompt,
          validates the model's output against it, and Slack + this console render from it.
          Schemas stay within the runtime's JSON-schema subset (no $ref, oneOf, pattern).
        </div>
        {catalog.response_formats.map((format) => (
          <details key={format.name} id={`format-${format.name}`} className="lib-item">
            <summary>
              <span className="mono">{format.name}</span>
              <span className="muted small">
                {Object.keys(format.schema?.properties ?? {}).length} fields
              </span>
            </summary>
            <div style={{ padding: '10px 4px 4px' }}>
              <SchemaTable schema={format.schema} />
            </div>
          </details>
        ))}
      </div>
    </>
  );
}
