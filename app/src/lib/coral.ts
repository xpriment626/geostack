// Thin client for coral-server. Talks via Vite proxy:
//   /api/v1/* -> http://localhost:5555
//   /ws/v1/*  -> ws://localhost:5555

const TOKEN = 'local'

// ----- Types mirrored from coral-server -----

export interface SessionIdentifier {
  sessionId: string
  namespace: string
}

export interface SessionThreadMessage {
  id: string
  threadId: string
  text: string
  senderName: string
  mentionNames: string[]
  timestamp: string
}

export interface SessionThread {
  id: string
  name: string
  creatorName: string
  participants: string[]
  // ... server returns more, we only use these
}

export type SessionEvent =
  | { type: 'thread_message_sent'; message: SessionThreadMessage }
  | { type: 'thread_created'; thread: SessionThread }
  | { type: 'thread_participant_added'; threadId: string; name: string }
  | { type: 'agent_connected'; name: string }
  | { type: string; [k: string]: unknown }

// ----- Session creation -----

export interface CreateSessionRequest {
  agentGraphRequest: {
    agents: Array<{
      id: { name: string; version: string; registrySourceId: { type: 'local' | 'marketplace' } }
      name: string
      provider: { type: 'local'; runtime: 'prototype' | 'executable' | 'docker' | 'function' }
      proxies?: Record<string, { configurationName: string; modelName: string }>
      systemPrompt?: string
      blocking?: boolean
    }>
    groups?: Array<string[]>
  }
  namespaceProvider:
    | { type: 'create_if_not_exists'; namespaceRequest: { name: string; deleteOnLastSessionExit?: boolean } }
    | { type: 'use_existing'; name: string }
  execution?: { mode: 'immediate' } | { mode: 'defer' }
}

const authHeaders = (extra: Record<string, string> = {}): HeadersInit => ({
  'Content-Type': 'application/json',
  Authorization: `Bearer ${TOKEN}`,
  ...extra,
})

async function jsonOrThrow<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Coral ${res.status}: ${text || res.statusText}`)
  }
  return (await res.json()) as T
}

export async function createSession(req: CreateSessionRequest): Promise<SessionIdentifier> {
  const res = await fetch('/api/v1/local/session', {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify(req),
  })
  return jsonOrThrow<SessionIdentifier>(res)
}

export async function closeSession(s: SessionIdentifier): Promise<void> {
  await fetch(`/api/v1/local/session/${s.namespace}/${s.sessionId}`, {
    method: 'DELETE',
    headers: authHeaders(),
  })
}

// ----- Puppet API: act as a given agent -----

export async function puppetCreateThread(
  s: SessionIdentifier,
  agentName: string,
  body: { threadName: string; participantNames: string[] },
): Promise<{ thread: SessionThread }> {
  const res = await fetch(`/api/v1/puppet/${s.namespace}/${s.sessionId}/${agentName}/thread`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify(body),
  })
  return jsonOrThrow(res)
}

export async function puppetSendMessage(
  s: SessionIdentifier,
  agentName: string,
  body: { threadId: string; content: string; mentions: string[] },
): Promise<{ status: string; message: SessionThreadMessage }> {
  const res = await fetch(`/api/v1/puppet/${s.namespace}/${s.sessionId}/${agentName}/thread/message`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify(body),
  })
  return jsonOrThrow(res)
}

// ----- Session WS event stream -----

export interface EventSubscription {
  close(): void
}

export function subscribeSessionEvents(
  s: SessionIdentifier,
  onEvent: (e: SessionEvent) => void,
  onClose?: (info: { code: number; reason: string }) => void,
): EventSubscription {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws'
  const url = `${proto}://${location.host}/ws/v1/events/${TOKEN}/session/${s.namespace}/${s.sessionId}`
  console.log('[Coral WS] connecting to', url)
  const ws = new WebSocket(url)
  ws.onopen = () => console.log('[Coral WS] open')
  ws.onmessage = (msg) => {
    console.log('[Coral WS] frame', msg.data)
    try {
      onEvent(JSON.parse(msg.data) as SessionEvent)
    } catch (err) {
      console.warn('Coral WS: bad frame', err, msg.data)
    }
  }
  ws.onerror = (e) => console.warn('[Coral WS] error', e)
  ws.onclose = (e) => {
    console.log('[Coral WS] close', e.code, e.reason)
    onClose?.({ code: e.code, reason: e.reason })
  }
  return {
    close() {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close()
    },
  }
}
