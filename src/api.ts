import type { Core } from '../server/core.ts';
export type Overview = ReturnType<Core['overview']> & { humanToken: string };
let token = '';
export async function api<T = any>(route: string, body?: unknown, method = 'POST'): Promise<T> {
  const response = await fetch(`/api${route}`, {
    method: body === undefined ? 'GET' : method,
    headers: { 'Content-Type': 'application/json', 'X-AACL-Token': token },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? '通信に失敗しました');
  return result;
}
export async function fetchState() {
  const data = await api<Overview>('/state');
  token = data.humanToken;
  return data;
}
