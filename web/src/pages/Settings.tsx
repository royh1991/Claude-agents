import { useState } from 'react';
import { api } from '../api';
import { useFetch } from '../hooks';
import type { ProviderKey } from '../types';
import { timeAgo } from '../format';

const PROVIDERS: { id: ProviderKey['provider']; label: string; hint: string }[] = [
  { id: 'google', label: 'Google (Gemini)', hint: 'Used by the gemini-cli harness — required for the current runner.' },
  { id: 'anthropic', label: 'Anthropic (Claude)', hint: 'Reserved for a future harness upgrade.' },
  { id: 'openai', label: 'OpenAI', hint: 'Reserved for a future harness upgrade.' },
];

export function Settings() {
  const { data, reload, error } = useFetch<{ data: ProviderKey[] }>('/v1/provider_keys');
  const [adding, setAdding] = useState<ProviderKey['provider'] | null>(null);
  const [value, setValue] = useState('');
  const [name, setName] = useState('');
  const [formError, setFormError] = useState<string | null>(null);

  const keys = new Map((data?.data ?? []).map((k) => [k.provider, k]));

  async function save() {
    if (!adding) return;
    setFormError(null);
    try {
      await api.post('/v1/provider_keys', { provider: adding, value: value.trim(), name: name.trim() || undefined });
      setAdding(null);
      setValue('');
      setName('');
      reload();
    } catch (e) {
      setFormError((e as Error).message);
    }
  }

  async function remove(key: ProviderKey) {
    if (!window.confirm(`Remove the ${key.provider} key? Scheduled sessions for ${key.provider} models will fail until a new key is added.`)) return;
    await api.del(`/v1/provider_keys/${key.id}`);
    reload();
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Model providers</h1>
          <div className="sub">
            Bring your own model. Keys are stored by the control plane and handed only to the
            Airflow worker when it claims a session — never to the browser.
          </div>
        </div>
      </div>

      {error && <div className="alert error">Couldn't load keys: {error}</div>}

      {PROVIDERS.map((provider) => {
        const key = keys.get(provider.id);
        return (
          <div className="card" key={provider.id}>
            <div className="card-head-row">
              <h2 style={{ marginBottom: 4 }}>{provider.label}</h2>
              {key
                ? <button type="button" className="btn small danger" onClick={() => remove(key)}>Remove key</button>
                : <button type="button" className="btn small" onClick={() => { setAdding(provider.id); setFormError(null); }}>Add key</button>}
            </div>
            <div className="muted small" style={{ marginBottom: key || adding === provider.id ? 12 : 0 }}>{provider.hint}</div>

            {key && (
              <dl className="kv">
                <dt>Key</dt><dd className="mono">{key.masked_value}</dd>
                <dt>Label</dt><dd>{key.name}</dd>
                <dt>Added</dt><dd>{timeAgo(key.created_at)}</dd>
                <dt>Last used</dt><dd>{key.last_used_at ? timeAgo(key.last_used_at) : 'never'}</dd>
              </dl>
            )}

            {adding === provider.id && !key && (
              <div>
                {formError && <div className="alert error">{formError}</div>}
                <div className="form-row">
                  <div className="field">
                    <label htmlFor={`key-${provider.id}`}>API key</label>
                    <input id={`key-${provider.id}`} type="password" className="mono" value={value}
                      onChange={(e) => setValue(e.target.value)} placeholder="paste the key" autoComplete="off" />
                  </div>
                  <div className="field">
                    <label htmlFor={`name-${provider.id}`}>Label (optional)</label>
                    <input id={`name-${provider.id}`} type="text" value={name}
                      onChange={(e) => setName(e.target.value)} placeholder="team or project name" />
                  </div>
                </div>
                <div className="form-actions" style={{ marginTop: 0 }}>
                  <button type="button" className="btn primary" onClick={save} disabled={!value.trim()}>Save key</button>
                  <button type="button" className="btn" onClick={() => setAdding(null)}>Cancel</button>
                </div>
              </div>
            )}
          </div>
        );
      })}
    </>
  );
}
