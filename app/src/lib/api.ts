// Thin client for the Geostack conductor, reached via the Vite proxy
// (/conductor/* -> http://localhost:8787). Same base works in installed mode
// once the conductor serves the built UI same-origin under /conductor.

const BASE = '/conductor'

export async function api<T = unknown>(path: string, opts?: RequestInit): Promise<T> {
  const r = await fetch(BASE + path, {
    headers: opts?.body ? { 'content-type': 'application/json' } : undefined,
    ...opts,
  })
  if (!r.ok) throw new Error(`${path} → ${r.status}`)
  return r.json() as Promise<T>
}

// ---- shapes (mirror the conductor) -----------------------------------------

export interface Project {
  id: string
  name: string
  description?: string
  audience?: string
  tone?: string
  topic_meta?: string | null
  created_at?: number
  updated_at?: number
}

export interface ConfigStatus {
  keys: Record<string, { set: boolean; hint: string }>
  storage: { mode: 'local' | 'cloud'; path: string }
}

export const listProjects = () => api<{ projects: Project[] }>('/projects').then((r) => r.projects)
export const getProject = (id: string) => api<Project>(`/projects/${id}`)
export const createProject = (body: Partial<Project>) =>
  api<Project>('/projects', { method: 'POST', body: JSON.stringify(body) })
export const updateProject = (id: string, body: Partial<Project> & { topicMeta?: unknown }) =>
  api<Project>(`/projects/${id}`, { method: 'PATCH', body: JSON.stringify(body) })

export const getConfig = () => api<ConfigStatus>('/config')
export const putConfig = (body: Record<string, string>) =>
  api<{ ok: boolean }>('/config', { method: 'PUT', body: JSON.stringify(body) })
