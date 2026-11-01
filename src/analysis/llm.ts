import Anthropic from '@anthropic-ai/sdk'
import type { Settings } from '../db'
import {
  MAX_TOKENS,
  ProviderError,
  RefusalError,
  completeHttp,
  type Completion,
  type Connection,
  type LlmRequest,
} from './providers'

export type { LlmRequest } from './providers'

// 料金は2026年10月時点。Claude以外は各社の一覧から選ぶ
export const CLAUDE_MODELS = [
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5', input: 4, output: 20 },
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5', input: 2, output: 10 },
  { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5', input: 0.1, output: 0.5 },
]

// 実行前の目安に使う出力量(思考分を含む)
const EXPECTED_OUTPUT_TOKENS = 4000
// Claude以外は事前に数えられないので、日本語の文字数から概算する
const TOKENS_PER_CHAR = 1.2
const FALLBACK_BETA = 'server-side-fallback-2026-07-01'
export const USD_JPY = 150

export function connectionFrom(settings: Settings): Connection {
  const { provider } = settings
  const model = settings.models[provider] ?? ''
  const claude = CLAUDE_MODELS.find((m) => m.id === model)
  return {
    provider,
    apiKey: settings.keys[provider] ?? '',
    model,
    price: claude ? { input: claude.input, output: claude.output } : settings.prices[`${provider}:${model}`],
    ...(provider === 'custom' ? { baseUrl: settings.customUrl } : {}),
  }
}

function clientFor(apiKey: string) {
  // キーは利用者自身のもので、このブラウザから Anthropic へ直接送る
  return new Anthropic({ apiKey, dangerouslyAllowBrowser: true })
}

const costOf = (conn: Connection, input: number, output: number) =>
  conn.price ? (input * conn.price.input + output * conn.price.output) / 1_000_000 : undefined

export function formatCost(usd: number) {
  return `$${usd.toFixed(3)}(約${Math.max(1, Math.round(usd * USD_JPY))}円)`
}

export async function estimate(conn: Connection, req: LlmRequest) {
  const inputTokens =
    conn.provider === 'anthropic'
      ? (
          await clientFor(conn.apiKey).messages.countTokens({
            model: conn.model,
            system: req.system,
            messages: [{ role: 'user', content: req.user }],
          })
        ).input_tokens
      : Math.round((req.system.length + req.user.length) * TOKENS_PER_CHAR)
  return { inputTokens, usd: costOf(conn, inputTokens, EXPECTED_OUTPUT_TOKENS) }
}

async function completeClaude(
  conn: Connection,
  req: LlmRequest,
  onText?: (text: string) => void,
  signal?: AbortSignal,
  effort: 'low' | 'medium' = 'medium',
): Promise<Completion> {
  const stream = clientFor(conn.apiKey).beta.messages.stream(
    {
      model: conn.model,
      max_tokens: MAX_TOKENS,
      system: req.system,
      messages: [{ role: 'user', content: req.user }],
      output_config: {
        effort,
        ...(req.schema ? { format: { type: 'json_schema' as const, schema: req.schema } } : {}),
      },
      // Haiku にはサーバー側フォールバックがない
      ...(conn.model.startsWith('claude-haiku') ? {} : { betas: [FALLBACK_BETA], fallbacks: 'default' as const }),
    },
    { signal },
  )
  if (onText) stream.on('text', (_delta, snapshot) => onText(snapshot))
  const message = await stream.finalMessage()
  if (message.stop_reason === 'refusal') {
    throw new RefusalError(message.stop_details?.explanation ?? '')
  }
  const { input_tokens: inputTokens, output_tokens: outputTokens } = message.usage
  const served = CLAUDE_MODELS.find((m) => m.id === message.model)
  return {
    text: message.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join(''),
    truncated: message.stop_reason === 'max_tokens',
    inputTokens,
    outputTokens,
    costUsd: costOf({ ...conn, price: served ?? conn.price }, inputTokens, outputTokens),
  }
}

export function complete(
  conn: Connection,
  req: LlmRequest,
  onText?: (text: string) => void,
  signal?: AbortSignal,
  effort: 'low' | 'medium' = 'medium',
) {
  return conn.provider === 'anthropic'
    ? completeClaude(conn, req, onText, signal, effort)
    : completeHttp(conn, req, onText, signal)
}

function explainStatus(status: number | undefined, message: string) {
  if (status === 401 || status === 403 || /api[ _-]?key/i.test(message)) {
    return 'APIキーが正しくありません。設定を確認してください。'
  }
  if (status === 402) return 'APIの残高が足りません。'
  if (status === 404) return 'このモデルは使えません。設定で別のモデルを選んでください。'
  if (status === 429) return '利用上限に達しました。少し待ってから試してください。'
  const detail = message ? `(${message})` : ''
  return `AIからエラーが返りました(${status})。設定で別のモデルも試してください。${detail}`
}

export function explainError(err: unknown): string {
  if (err instanceof RefusalError) {
    return 'AIがこの依頼を断りました。質問の表現を変えて試してください。'
  }
  if (err instanceof SyntaxError) return 'AIの返答を読み取れませんでした。もう一度試すか、別のモデルを選んでください。'
  if (err instanceof Anthropic.APIConnectionError) return 'AIに接続できませんでした。通信状況を確認してください。'
  if (err instanceof Anthropic.APIError) return explainStatus(err.status, '')
  if (err instanceof ProviderError) return explainStatus(err.status, err.message)
  if (err instanceof TypeError) return 'AIに接続できませんでした。通信状況を確認してください。'
  return err instanceof Error ? err.message : String(err)
}
