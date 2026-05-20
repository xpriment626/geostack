// Thin Replicate client. Talks via the Vite /replicate proxy which adds the
// bearer token server-side, so VITE_REPLICATE_API_TOKEN is never exposed to
// the browser and CORS is sidestepped.

interface CreatePredictionInput {
  prompt: string
  aspect_ratio?: '1:1' | '3:2' | '2:3'
  quality?: 'low' | 'medium' | 'high' | 'auto'
  number_of_images?: number
  output_format?: 'webp' | 'png' | 'jpeg'
}

interface PredictionRecord {
  id: string
  status: 'starting' | 'processing' | 'succeeded' | 'failed' | 'canceled'
  output?: string[] | null
  error?: string | null
  urls?: { get?: string; cancel?: string }
}

// Calls openai/gpt-image-2 on Replicate. Returns the first image URL when the
// prediction succeeds. Polls every 2s, gives up after `maxWaitMs`.
export async function generateThumbnail(
  input: CreatePredictionInput,
  opts: { maxWaitMs?: number; pollMs?: number } = {},
): Promise<string> {
  const maxWaitMs = opts.maxWaitMs ?? 120_000
  const pollMs = opts.pollMs ?? 2_000

  const body = {
    input: {
      prompt: input.prompt,
      aspect_ratio: input.aspect_ratio ?? '3:2',
      quality: input.quality ?? 'medium',
      number_of_images: input.number_of_images ?? 1,
      output_format: input.output_format ?? 'webp',
    },
  }

  const createRes = await fetch('/replicate/models/openai/gpt-image-2/predictions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!createRes.ok) {
    const text = await createRes.text().catch(() => '')
    throw new Error(`Replicate create failed ${createRes.status}: ${text}`)
  }
  let prediction = (await createRes.json()) as PredictionRecord

  const started = Date.now()
  while (
    prediction.status !== 'succeeded' &&
    prediction.status !== 'failed' &&
    prediction.status !== 'canceled'
  ) {
    if (Date.now() - started > maxWaitMs) {
      throw new Error(`Replicate timed out after ${maxWaitMs}ms (last status: ${prediction.status})`)
    }
    await new Promise((r) => setTimeout(r, pollMs))
    const pollRes = await fetch(`/replicate/predictions/${prediction.id}`)
    if (!pollRes.ok) {
      const text = await pollRes.text().catch(() => '')
      throw new Error(`Replicate poll failed ${pollRes.status}: ${text}`)
    }
    prediction = (await pollRes.json()) as PredictionRecord
  }

  if (prediction.status !== 'succeeded') {
    throw new Error(`Replicate prediction ${prediction.status}: ${prediction.error ?? 'unknown error'}`)
  }
  const first = prediction.output?.[0]
  if (!first) throw new Error('Replicate succeeded but returned no output')
  return first
}
