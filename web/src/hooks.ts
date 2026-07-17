import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api';
import type { Catalog } from './types';

export function useFetch<T>(path: string | null, pollMs?: number) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pathRef = useRef(path);
  pathRef.current = path;

  const reload = useCallback(() => {
    const requested = pathRef.current;
    if (!requested) return;
    api.get<T>(requested)
      .then((d) => {
        // Drop the response if the component navigated to a different path
        // while this reload was in flight.
        if (pathRef.current === requested) { setData(d); setError(null); }
      })
      .catch((e: Error) => {
        if (pathRef.current === requested) setError(e.message);
      });
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
        api.get<T>(path)
          .then((d) => { if (alive) { setData(d); setError(null); } })
          .catch((e: Error) => { if (alive) setError(e.message); });
      }, pollMs);
    }
    return () => { alive = false; if (timer) clearInterval(timer); };
  }, [path, pollMs]);

  return { data, error, reload };
}

export function useCatalog() {
  return useFetch<Catalog>('/api/catalog');
}

export function agentNameIndex(catalog: Catalog | null): Map<string, string> {
  const index = new Map<string, string>();
  for (const agent of catalog?.agents ?? []) {
    index.set(agent.id, agent.config?.name ?? agent.id);
  }
  return index;
}
