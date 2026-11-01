import type { ProviderId } from '../db'

export type Price = { input: number; output: number }

export type Connection = { provider: ProviderId; apiKey: string; model: string; price?: Price; baseUrl?: string }

export type LlmRequest = {
  system: string
  user: string
  schema?: Record<string, unknown>
}

export type Completion = {
  text: string
  truncated: boolean
  inputTokens: number
  outputTokens: number
  costUsd?: number
}

export type ModelInfo = { id: string; price?: Price }

export const MAX_TOKENS = 16000

export const PROVIDERS: { id: ProviderId; label: string; keyHint: string; keyUrl: string; note: string }[] = [
  {
    id: 'anthropic',
    label: 'Claude(Anthropic)',
    keyHint: 'sk-ant-...',
    keyUrl: 'https://console.anthropic.com/',
    note: '18歳以上の方がご利用ください。',
  },
  {
    id: 'openai',
    label: 'ChatGPT(OpenAI)',
    keyHint: 'sk-...',
    keyUrl: 'https://platform.openai.com/api-keys',
    note: 'OpenAIはAPIキーをブラウザに置かないよう案内しています。使う場合は期限と上限を付けた専用のキーにしてください。',
  },
  {
    id: 'gemini',
    label: 'Gemini(Google)',
    keyHint: 'AIza...',
    keyUrl: 'https://aistudio.google.com/apikey',
    note: '18歳以上の方がご利用ください。無料枠では送った内容がGoogleの改善や人による確認に使われることがあり、個人情報を送らないよう案内されています。有料設定のキーをおすすめします。',
  },
  {
    id: 'openrouter',
    label: 'OpenRouter(各社のモデル)',
    keyHint: 'sk-or-...',
    keyUrl: 'https://openrouter.ai/keys',
    note: '18歳以上の方がご利用ください。モデルごとの提供元の規約も適用されます。',
  },
  {
    id: 'custom',
    label: 'カスタムAPI(OpenAI互換)',
    keyHint: 'なくても使えます',
    keyUrl: '',
    note: 'llama.cpp、Ollama、LM Studio、vLLMなどをこのPCで動かして使えます。公開版から接続できるのは localhost と 127.0.0.1 だけです。サーバー側で、このサイトからの接続(CORS)を許可してください。投稿が多いとモデルの読める量を超えることがあり、紙面の出来はモデルによって変わります。',
  },
]

// OpenAI と Google はキーをブラウザに置かないよう案内しているので、公開版では外して手元の開発版だけで使う
const PUBLIC_PROVIDERS: ProviderId[] = ['anthropic', 'openrouter', 'custom']

export function availableProviders(dev: boolean = import.meta.env.DEV) {
  return PROVIDERS.filter((p) => dev || PUBLIC_PROVIDERS.includes(p.id))
}

export class RefusalError extends Error {}

export class ProviderError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

async function post(url: string, headers: Record<string, string>, body: unknown, signal?: AbortSignal) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal,
  })
  if (!res.ok) throw await toError(res)
  return res
}

async function toError(res: Response) {
  const data = await res.json().catch(() => undefined)
  const error = Array.isArray(data) ? data[0]?.error : data?.error
  return new ProviderError(res.status, error?.message ?? res.statusText)
}

// Server-Sent Events の data 行だけを順に取り出す
async function* readEvents(res: Response) {
  const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader()
  let buffer = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) return
    buffer += value
    const lines = buffer.split('\n')
    buffer = lines.pop()!
    for (const line of lines) {
      const data = line.trim()
      if (!data.startsWith('data:')) continue
      const json = data.slice(5).trim()
      if (json === '[DONE]') return
      yield JSON.parse(json)
    }
  }
}

const priceOf = (price: Price | undefined, input: number, output: number) =>
  price ? (input * price.input + output * price.output) / 1_000_000 : undefined

type OnText = ((text: string) => void) | undefined

const bearer = (apiKey: string): Record<string, string> => (apiKey ? { authorization: `Bearer ${apiKey}` } : {})

// /v1 の省略や、/chat/completions まで書いた形も受け付ける
export function customBase(url = '') {
  const base = url.trim().replace(/\/+$/, '').replace(/\/chat\/completions$/, '')
  if (!/^https?:\/\//.test(base)) throw new Error('API Base URLは http:// か https:// から書いてください。')
  return /^https?:\/\/[^/]+$/.test(base) ? `${base}/v1` : base
}

// fetch の失敗だけでは原因が分からないので、確認する場所を伝える
async function reachCustom<T>(request: () => Promise<T>) {
  try {
    return await request()
  } catch (err) {
    if (err instanceof TypeError) {
      throw new Error(
        'カスタムAPIに接続できませんでした。サーバーの起動、Base URL、CORSの許可を確認してください。公開版では localhost と 127.0.0.1 以外に接続できません。',
      )
    }
    throw err
  }
}

// OpenAI、OpenRouter、カスタムAPIは同じ Chat Completions 形式で呼べる
async function chatCompletions(
  conn: Connection,
  req: LlmRequest,
  onText: OnText,
  signal: AbortSignal | undefined,
  options: { url: string; maxTokensField: string; extra?: Record<string, unknown> },
): Promise<Completion> {
  const res = await post(
    options.url,
    bearer(conn.apiKey),
    {
      model: conn.model,
      messages: [
        { role: 'system', content: req.system },
        { role: 'user', content: req.user },
      ],
      stream: true,
      stream_options: { include_usage: true },
      [options.maxTokensField]: MAX_TOKENS,
      ...(req.schema
        ? {
            response_format: { type: 'json_schema', json_schema: { name: 'result', strict: true, schema: req.schema } },
            ...options.extra,
          }
        : {}),
    },
    signal,
  )

  let text = ''
  let finish: string | undefined
  let usage: { prompt_tokens?: number; completion_tokens?: number; cost?: number } | undefined
  for await (const event of readEvents(res)) {
    if (event.error) throw new ProviderError(event.error.code ?? 500, event.error.message ?? '')
    usage = event.usage ?? usage
    const choice = event.choices?.[0]
    if (!choice) continue
    finish = choice.finish_reason ?? finish
    if (choice.delta?.refusal) throw new RefusalError(choice.delta.refusal)
    if (choice.delta?.content) {
      text += choice.delta.content
      onText?.(text)
    }
  }
  if (finish === 'content_filter') throw new RefusalError('')

  const inputTokens = usage?.prompt_tokens ?? 0
  const outputTokens = usage?.completion_tokens ?? 0
  return {
    text,
    truncated: finish === 'length',
    inputTokens,
    outputTokens,
    costUsd: usage?.cost ?? priceOf(conn.price, inputTokens, outputTokens),
  }
}

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta'
const GEMINI_BLOCKED = ['SAFETY', 'RECITATION', 'PROHIBITED_CONTENT', 'BLOCKLIST', 'SPII']

async function gemini(conn: Connection, req: LlmRequest, onText: OnText, signal?: AbortSignal): Promise<Completion> {
  const res = await post(
    `${GEMINI_BASE}/models/${encodeURIComponent(conn.model)}:streamGenerateContent?alt=sse`,
    { 'x-goog-api-key': conn.apiKey },
    {
      systemInstruction: { parts: [{ text: req.system }] },
      contents: [{ role: 'user', parts: [{ text: req.user }] }],
      generationConfig: {
        maxOutputTokens: MAX_TOKENS,
        ...(req.schema ? { responseMimeType: 'application/json', responseJsonSchema: req.schema } : {}),
      },
    },
    signal,
  )

  let text = ''
  let finish: string | undefined
  let inputTokens = 0
  let outputTokens = 0
  for await (const event of readEvents(res)) {
    if (event.promptFeedback?.blockReason) throw new RefusalError(event.promptFeedback.blockReason)
    const usage = event.usageMetadata
    if (usage) {
      inputTokens = usage.promptTokenCount ?? inputTokens
      outputTokens = (usage.candidatesTokenCount ?? 0) + (usage.thoughtsTokenCount ?? 0)
    }
    const candidate = event.candidates?.[0]
    finish = candidate?.finishReason ?? finish
    for (const part of candidate?.content?.parts ?? []) {
      if (part.thought || !part.text) continue
      text += part.text
      onText?.(text)
    }
  }
  if (finish && GEMINI_BLOCKED.includes(finish)) throw new RefusalError(finish)
  return {
    text,
    truncated: finish === 'MAX_TOKENS',
    inputTokens,
    outputTokens,
    costUsd: priceOf(conn.price, inputTokens, outputTokens),
  }
}

export function completeHttp(conn: Connection, req: LlmRequest, onText: OnText, signal?: AbortSignal) {
  switch (conn.provider) {
    case 'gemini':
      return gemini(conn, req, onText, signal)
    case 'openrouter':
      return chatCompletions(conn, req, onText, signal, {
        url: 'https://openrouter.ai/api/v1/chat/completions',
        maxTokensField: 'max_tokens',
        // 構造化出力に対応した提供元だけに送る
        extra: { provider: { require_parameters: true } },
      })
    case 'custom':
      return reachCustom(() =>
        chatCompletions(conn, req, onText, signal, {
          url: `${customBase(conn.baseUrl)}/chat/completions`,
          maxTokensField: 'max_tokens',
        }),
      )
    default:
      return chatCompletions(conn, req, onText, signal, {
        url: 'https://api.openai.com/v1/chat/completions',
        maxTokensField: 'max_completion_tokens',
      })
  }
}

const OPENAI_NOT_CHAT = /audio|realtime|image|transcribe|tts|search|embedding|moderation|sora|codex/

// モデルの入れ替わりが早いので、固定で持たず各社の一覧から選んでもらう
export async function listModels(provider: ProviderId, apiKey: string, baseUrl?: string): Promise<ModelInfo[]> {
  const get = async (url: string, headers: Record<string, string>) => {
    const res = await fetch(url, { headers })
    if (!res.ok) throw await toError(res)
    return res.json()
  }

  if (provider === 'custom') {
    const url = `${customBase(baseUrl)}/models`
    const { data } = await reachCustom(() => get(url, bearer(apiKey)))
    return (data as { id: string }[]).map(({ id }) => ({ id }))
  }

  if (provider === 'openai') {
    const { data } = await get('https://api.openai.com/v1/models', { authorization: `Bearer ${apiKey}` })
    return (data as { id: string; created: number }[])
      .filter((m) => /^(gpt|o\d|chatgpt)/.test(m.id) && !OPENAI_NOT_CHAT.test(m.id))
      .sort((a, b) => b.created - a.created)
      .map(({ id }) => ({ id }))
  }

  if (provider === 'gemini') {
    const { models } = await get(`${GEMINI_BASE}/models?pageSize=200`, { 'x-goog-api-key': apiKey })
    return (models as { name: string; supportedGenerationMethods?: string[] }[])
      .filter((m) => m.supportedGenerationMethods?.includes('generateContent'))
      .map((m) => m.name.replace(/^models\//, ''))
      .filter((id) => id.startsWith('gemini') && !/image|tts|live|embedding/.test(id))
      .reverse()
      .map((id) => ({ id }))
  }

  const { data } = await get('https://openrouter.ai/api/v1/models', { authorization: `Bearer ${apiKey}` })
  return (data as { id: string; pricing?: { prompt?: string; completion?: string }; supported_parameters?: string[] }[])
    .filter((m) => m.supported_parameters?.includes('response_format') && !m.id.endsWith(':batch'))
    .map((m) => {
      const input = Number(m.pricing?.prompt) * 1_000_000
      const output = Number(m.pricing?.completion) * 1_000_000
      // 料金が変動するモデルは負の値や空で返る
      return { id: m.id, price: input >= 0 && output >= 0 ? { input, output } : undefined }
    })
}
