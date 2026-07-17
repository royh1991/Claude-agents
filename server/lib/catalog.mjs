// Reads the backend package's catalogs from disk: agent packs, skills,
// tools, response formats, environments, guardrails. The console never
// invents catalog data — everything comes from the backend checkout
// (or the bundled fixture when no checkout is configured).
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';

export const AGENT_ID_PATTERN = /^[a-z][a-z0-9-]{2,80}$/;

function moduleDir() {
  return path.dirname(new URL(import.meta.url).pathname);
}

export function resolveBackendPaths(env = process.env) {
  const repoRoot = env.BACKEND_REPO_ROOT
    ? path.resolve(env.BACKEND_REPO_ROOT)
    : path.resolve(moduleDir(), '..', '..', 'backend-fixture');
  const packageDir = env.BACKEND_PACKAGE_DIR ?? 'dags/credible_bi_airflow_triage';
  const packageRoot = path.resolve(repoRoot, packageDir);
  return { repoRoot, packageDir, packageRoot, usingFixture: !env.BACKEND_REPO_ROOT };
}

function readIfExists(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function parseYamlSafe(text, file) {
  try {
    return { value: YAML.parse(text), error: null };
  } catch (err) {
    return { value: null, error: `${path.basename(file)}: ${err.message}` };
  }
}

function listDir(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

export function loadAgents(packageRoot) {
  const agentsDir = path.join(packageRoot, 'agents');
  const agents = [];
  for (const entry of listDir(agentsDir)) {
    if (!entry.isDirectory()) continue;
    const id = entry.name;
    const yamlPath = path.join(agentsDir, id, 'agent.yaml');
    const raw = readIfExists(yamlPath);
    if (raw === null) continue; // legacy agent.json-only packs are not editable here
    const { value, error } = parseYamlSafe(raw, yamlPath);
    agents.push({
      id,
      path: path.relative(packageRoot, yamlPath),
      raw,
      config: value,
      parse_error: error,
      dir_mismatch: value && value.id !== id ? `agent.yaml id "${value.id}" does not match directory "${id}"` : null,
    });
  }
  return agents.sort((a, b) => a.id.localeCompare(b.id));
}

export function loadSkills(packageRoot) {
  const dir = path.join(packageRoot, 'skills');
  const skills = [];
  for (const entry of listDir(dir)) {
    if (!entry.isFile() || !entry.name.endsWith('.md') || entry.name === 'README.md') continue;
    const body = readIfExists(path.join(dir, entry.name)) ?? '';
    skills.push({
      id: entry.name.replace(/\.md$/, ''),
      title: (body.match(/^#\s*(.+)$/m) ?? [null, entry.name])[1],
      body,
    });
  }
  return skills.sort((a, b) => a.id.localeCompare(b.id));
}

export function loadTools(packageRoot) {
  const dir = path.join(packageRoot, 'tools');
  const tools = [];
  for (const entry of listDir(dir)) {
    if (!entry.isFile() || !/\.ya?ml$/.test(entry.name)) continue;
    const file = path.join(dir, entry.name);
    const raw = readIfExists(file) ?? '';
    const { value, error } = parseYamlSafe(raw, file);
    tools.push({
      name: value?.name ?? entry.name.replace(/\.ya?ml$/, ''),
      description: value?.description ?? '',
      permission_policy: value?.permission_policy ?? null,
      input_schema: value?.input_schema ?? null,
      raw,
      parse_error: error,
    });
  }
  return tools.sort((a, b) => a.name.localeCompare(b.name));
}

export function loadResponseFormats(packageRoot) {
  const dir = path.join(packageRoot, 'response_formats');
  const formats = [];
  for (const entry of listDir(dir)) {
    if (!entry.isFile() || !/\.ya?ml$/.test(entry.name)) continue;
    const file = path.join(dir, entry.name);
    const raw = readIfExists(file) ?? '';
    const { value, error } = parseYamlSafe(raw, file);
    formats.push({
      name: value?.name ?? entry.name.replace(/\.ya?ml$/, ''),
      schema: value?.schema ?? null,
      raw,
      parse_error: error,
    });
  }
  return formats.sort((a, b) => a.name.localeCompare(b.name));
}

export function loadEnvironments(packageRoot) {
  const dir = path.join(packageRoot, 'environments');
  const environments = [];
  for (const entry of listDir(dir)) {
    if (!entry.isFile() || !/\.ya?ml$/.test(entry.name)) continue;
    const file = path.join(dir, entry.name);
    const raw = readIfExists(file) ?? '';
    const { value, error } = parseYamlSafe(raw, file);
    environments.push({
      id: value?.id ?? entry.name.replace(/\.ya?ml$/, ''),
      config: value,
      raw,
      parse_error: error,
    });
  }
  return environments.sort((a, b) => a.id.localeCompare(b.id));
}

export function loadTriggers(packageRoot) {
  const dir = path.join(packageRoot, 'agent_triggers');
  const triggers = [];
  for (const entry of listDir(dir)) {
    if (!entry.isFile() || !/\.ya?ml$/.test(entry.name)) continue;
    const file = path.join(dir, entry.name);
    const raw = readIfExists(file) ?? '';
    const { value, error } = parseYamlSafe(raw, file);
    triggers.push({
      id: value?.id ?? entry.name.replace(/\.ya?ml$/, ''),
      config: value,
      raw,
      parse_error: error,
    });
  }
  return triggers.sort((a, b) => a.id.localeCompare(b.id));
}

export function loadGuardrails(packageRoot) {
  return readIfExists(path.join(packageRoot, 'guardrails', 'guardrails.md'));
}

export function loadCatalog(paths) {
  const { packageRoot } = paths;
  return {
    backend: {
      repo_root: paths.repoRoot,
      package_dir: paths.packageDir,
      using_fixture: paths.usingFixture,
      package_exists: fs.existsSync(packageRoot),
    },
    agents: loadAgents(packageRoot),
    skills: loadSkills(packageRoot),
    tools: loadTools(packageRoot),
    response_formats: loadResponseFormats(packageRoot),
    environments: loadEnvironments(packageRoot),
    triggers: loadTriggers(packageRoot),
    guardrails: loadGuardrails(packageRoot),
  };
}
