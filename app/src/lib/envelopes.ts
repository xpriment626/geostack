// Wire protocol between InstaLetter agents and the frontend.
// Agents emit one of these as the `content` of a Coral message; the frontend
// parses and routes accordingly.

export type InputType = 'text' | 'textarea' | 'select' | 'multi_select' | 'confirm'

export interface QuestionEnvelope {
  type: 'question'
  id: string
  input_type: InputType
  label: string
  placeholder?: string
  options?: string[]
}

export interface BriefEnvelope {
  type: 'brief'
  title: string
  summary: string
  topic: string
  audience: string
  angle: string
  tone: string
  length: string
  raw: string
}

// Sent by the frontend (as user-proxy) into the wizard thread once the user
// clicks the Approve button. Signals brief-agent to transition to Phase 2.
export interface ApprovalEnvelope {
  type: 'approval'
}

// Emitted by thumbnail-agent. The frontend uses the prompt to call Replicate's
// gpt-image-2 directly (via the /replicate proxy).
export interface ThumbnailPromptEnvelope {
  type: 'thumbnail_prompt'
  prompt: string
  aspect_ratio?: '1:1' | '3:2' | '2:3'
  quality?: 'low' | 'medium' | 'high' | 'auto'
}

// Emitted by content-agent. Used internally between agents; the frontend
// shows it as a progress signal but doesn't render the markdown to the user
// (template-agent's `final` is what ships).
export interface DraftEnvelope {
  type: 'draft'
  markdown: string
}

// Emitted by template-agent. This is the polished post the user sees.
export interface FinalEnvelope {
  type: 'final'
  markdown: string
}

export type Envelope =
  | QuestionEnvelope
  | BriefEnvelope
  | ApprovalEnvelope
  | ThumbnailPromptEnvelope
  | DraftEnvelope
  | FinalEnvelope

const KNOWN_TYPES = new Set<Envelope['type']>([
  'question',
  'brief',
  'approval',
  'thumbnail_prompt',
  'draft',
  'final',
])

export function parseEnvelope(text: string): Envelope | null {
  const stripped = text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim()
  try {
    const obj = JSON.parse(stripped)
    if (obj && typeof obj === 'object' && typeof obj.type === 'string' && KNOWN_TYPES.has(obj.type)) {
      return obj as Envelope
    }
  } catch {
    /* not JSON — caller decides */
  }
  return null
}

// Compact markdown rendering of a brief, suitable for posting into the
// drafting thread as the message content addressed to content-agent.
export function briefToMarkdown(b: BriefEnvelope): string {
  return [
    `# ${b.title}`,
    '',
    b.summary,
    '',
    `**Topic:** ${b.topic}`,
    `**Audience:** ${b.audience}`,
    `**Angle:** ${b.angle}`,
    `**Tone:** ${b.tone}`,
    `**Length:** ${b.length}`,
    '',
    b.raw ? '---' : '',
    b.raw ?? '',
  ]
    .filter((line, i, arr) => !(line === '' && arr[i - 1] === ''))
    .join('\n')
    .trim()
}
