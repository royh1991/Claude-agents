import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api';

export function useFetch<T>(path: string | null, pollMs?: number) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pathRef = useRef(path);
  pathRef.current = path;

  const reload = useCallback(() => {
    if (!pathRef.current) return;
    api.get<T>(pathRef.current)
      .then((d) => { setData(d); setError(null); })
      .catch((e: Error) => setError(e.message));
  }, []);

  useEffect(() => {
    setData(null);
    setError(null);
    if (!path) return;
    let alive = true;
    api.get<T>(path)
      .then((d) => { if (alive) { setData(d); setError(null); } })
      .catch((e: Error) => { if (alive) setError(e.message); });
    let timer: number | undefined;
    if (pollMs) {
      timer = window.setInterval(() => {
        api.get<T>(path).then((d) => { if (alive) setData(d); }).catch(() => {});
      }, pollMs);
    }
    return () => { alive = false; if (timer) clearInterval(timer); };
  }, [path, pollMs]);

  return { data, error, reload };
}

export function useAgentIndex() {
  const { data } = useFetch<{ data: { id: string; name: string; model: { id: string } }[] }>('/v1/agents?include_archived=true');
  const index = new Map<string, { name: string; model: string }>();
  for (const agent of data?.data ?? []) index.set(agent.id, { name: agent.name, model: agent.model.id });
  return index;
}

export function useEnvironmentIndex() {
  const { data } = useFetch<{ data: { id: string; name: string }[] }>('/v1/environments');
  const index = new Map<string, string>();
  for (const env of data?.data ?? []) index.set(env.id, env.name);
  return index;
}
