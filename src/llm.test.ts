import 'fake-indexeddb/auto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { complete, connectionFrom, estimate, explainError } from './analysis/llm'
import { ProviderError, availableProviders, customBase, listModels, type Connection } from './analysis/providers'
import { parseJson } from './analysis/result'
import { codeChallenge, finishOpenRouterLogin, loginUrl } from './analysis/openrouterLogin'
import { getSettings, migrateSettings } from './db'

const claude: Connection = { provider: 'anthropic', apiKey: 'key', model: 'claude-opus-5-5', price: { input: 4, output: 20 } }

function sse(stopReason: string, text: string) {
  const events = [
    ['message_start', { type: 'message_start', message: { id: 'm', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1000, output_tokens: 1 } } }],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 500 } }],
    ['message_stop', { type: 'message_stop' }],
  ]
  return new Response(events.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join(''), {
    headers: { 'content-type': 'text/event-stream' },
  })
}

const dataStream = (events: unknown[], done = true) =>
  new Response(
    events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('') + (done ? 'data: [DONE]\n\n' : ''),
    { headers: { 'content-type': 'text/event-stream' } },
  )

function stubFetch(response: () => Response) {
  const calls: { url: string; headers: Headers; body: any }[] = []
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    calls.push({
      url: String(url),
      headers: new Headers(init.headers),
      body: init.body ? JSON.parse(init.body as string) : undefined,
    })
    return response()
  })
  return calls
}

afterEach(() => vi.unstubAllGlobals())

const req = { system: 's', user: 'u' }

describe('Claude', () => {
  it('本文と費用を返し、Opusにはフォールバックを付ける', async () => {
    const calls = stubFetch(() => sse('end_turn', 'こんにちは'))
    const seen: string[] = []
    const out = await complete(claude, req, (t) => seen.push(t))
    expect(out.text).toBe('こんにちは')
    expect(seen.at(-1)).toBe('こんにちは')
    expect(out.costUsd).toBeCloseTo((1000 * 4 + 500 * 20) / 1_000_000)
    expect(calls[0].body.fallbacks).toBe('default')
    expect(calls[0].body.output_config.effort).toBe('medium')
    expect(calls[0].body.thinking).toBeUndefined()
    expect(calls[0].body.stream).toBe(true)
    expect(calls[0].headers.get('anthropic-beta')).toContain('server-side-fallback-2026-07-01')
    expect(calls[0].headers.get('anthropic-dangerous-direct-browser-access')).toBe('true')
  })

  it('Haikuにはフォールバックを付けない', async () => {
    const calls = stubFetch(() => sse('end_turn', 'x'))
    await complete({ ...claude, model: 'claude-haiku-5-5' }, req)
    expect(calls[0].body.fallbacks).toBeUndefined()
    expect(calls[0].headers.get('anthropic-beta')).toBeNull()
  })

  it('スキーマを渡すとJSON形式を指定する', async () => {
    const calls = stubFetch(() => sse('end_turn', '{}'))
    await complete(claude, { ...req, schema: { type: 'object' } })
    expect(calls[0].body.output_config.format).toEqual({ type: 'json_schema', schema: { type: 'object' } })
  })

  it('断られたらエラーにする', async () => {
    stubFetch(() => sse('refusal', ''))
    const err = await complete(claude, req).catch((e) => e)
    expect(explainError(err)).toContain('断りました')
  })

  it('途中で切れたことを返す', async () => {
    stubFetch(() => sse('max_tokens', '途中'))
    expect((await complete(claude, req)).truncated).toBe(true)
  })
})

describe('OpenAI', () => {
  const conn: Connection = { provider: 'openai', apiKey: 'key', model: 'gpt-x', price: { input: 2, output: 8 } }
  const chunk = (content: string, finish_reason: string | null = null) => ({
    choices: [{ delta: { content }, finish_reason }],
  })

  it('形式どおりに送り、本文と費用を返す', async () => {
    const calls = stubFetch(() =>
      dataStream([chunk('こん'), chunk('にちは', 'stop'), { choices: [], usage: { prompt_tokens: 1000, completion_tokens: 500 } }]),
    )
    const seen: string[] = []
    const out = await complete(conn, { ...req, schema: { type: 'object' } }, (t) => seen.push(t))
    expect(calls[0].url).toBe('https://api.openai.com/v1/chat/completions')
    expect(calls[0].headers.get('authorization')).toBe('Bearer key')
    expect(calls[0].body.messages[0]).toEqual({ role: 'system', content: 's' })
    expect(calls[0].body.max_completion_tokens).toBe(16000)
    expect(calls[0].body.response_format.json_schema.strict).toBe(true)
    expect(calls[0].body.response_format.json_schema.schema).toEqual({ type: 'object' })
    expect(out.text).toBe('こんにちは')
    expect(seen).toEqual(['こん', 'こんにちは'])
    expect(out.costUsd).toBeCloseTo((1000 * 2 + 500 * 8) / 1_000_000)
  })

  it('料金が不明なら費用を出さない', async () => {
    stubFetch(() => dataStream([chunk('x', 'stop')]))
    expect((await complete({ ...conn, price: undefined }, req)).costUsd).toBeUndefined()
  })

  it('長さの上限と拒否を見分ける', async () => {
    stubFetch(() => dataStream([chunk('途中', 'length')]))
    expect((await complete(conn, req)).truncated).toBe(true)
    stubFetch(() => dataStream([{ choices: [{ delta: { refusal: 'no' }, finish_reason: null }] }]))
    expect(explainError(await complete(conn, req).catch((e) => e))).toContain('断りました')
  })

  it('APIのエラーを日本語にする', async () => {
    stubFetch(() => new Response(JSON.stringify({ error: { message: 'bad' } }), { status: 401 }))
    expect(explainError(await complete(conn, req).catch((e) => e))).toContain('APIキー')
    stubFetch(() => new Response(JSON.stringify({ error: { message: 'none' } }), { status: 404 }))
    expect(explainError(await complete(conn, req).catch((e) => e))).toContain('モデル')
  })

  it('チャット用のモデルだけを新しい順に並べる', async () => {
    stubFetch(() =>
      Response.json({
        data: [
          { id: 'gpt-old', created: 1 },
          { id: 'gpt-new', created: 2 },
          { id: 'gpt-audio-1', created: 3 },
          { id: 'text-embedding-3', created: 4 },
        ],
      }),
    )
    expect(await listModels('openai', 'key')).toEqual([{ id: 'gpt-new' }, { id: 'gpt-old' }])
  })
})

describe('Gemini', () => {
  const conn: Connection = { provider: 'gemini', apiKey: 'key', model: 'gemini-x' }

  it('形式どおりに送り、思考を除いた本文を返す', async () => {
    const calls = stubFetch(() =>
      dataStream(
        [
          { candidates: [{ content: { parts: [{ text: '考え中', thought: true }] } }] },
          { candidates: [{ content: { parts: [{ text: 'こんにちは' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, thoughtsTokenCount: 3 } },
        ],
        false,
      ),
    )
    const out = await complete(conn, { ...req, schema: { type: 'object' } })
    expect(calls[0].url).toContain('/models/gemini-x:streamGenerateContent?alt=sse')
    expect(calls[0].headers.get('x-goog-api-key')).toBe('key')
    expect(calls[0].body.systemInstruction.parts[0].text).toBe('s')
    expect(calls[0].body.generationConfig.responseJsonSchema).toEqual({ type: 'object' })
    expect(out.text).toBe('こんにちは')
    expect(out.outputTokens).toBe(8)
  })

  it('安全フィルターで止まったら断られた扱いにする', async () => {
    stubFetch(() => dataStream([{ candidates: [{ finishReason: 'SAFETY' }] }], false))
    expect(explainError(await complete(conn, req).catch((e) => e))).toContain('断りました')
  })

  it('一覧から文章生成のモデルだけを選ぶ', async () => {
    stubFetch(() =>
      Response.json({
        models: [
          { name: 'models/gemini-a', supportedGenerationMethods: ['generateContent'] },
          { name: 'models/gemini-a-tts', supportedGenerationMethods: ['generateContent'] },
          { name: 'models/embedding-1', supportedGenerationMethods: ['embedContent'] },
        ],
      }),
    )
    expect(await listModels('gemini', 'key')).toEqual([{ id: 'gemini-a' }])
  })

  it('キーの誤りを 400 でも見分ける', () => {
    expect(explainError(new ProviderError(400, 'API key not valid.'))).toContain('APIキー')
  })
})

describe('OpenRouter', () => {
  const conn: Connection = { provider: 'openrouter', apiKey: 'key', model: 'a/b' }

  it('実費が返ればそれを使い、スキーマ対応の提供元に限定する', async () => {
    const calls = stubFetch(() =>
      dataStream([
        { choices: [{ delta: { content: '{}' }, finish_reason: 'stop' }] },
        { choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, cost: 0.25 } },
      ]),
    )
    const out = await complete(conn, { ...req, schema: { type: 'object' } })
    expect(calls[0].body.provider).toEqual({ require_parameters: true })
    expect(calls[0].body.max_tokens).toBe(16000)
    expect(out.costUsd).toBe(0.25)
  })

  it('一覧の料金を100万トークンあたりに直し、JSON非対応を除く', async () => {
    stubFetch(() =>
      Response.json({
        data: [
          { id: 'a/b', pricing: { prompt: '0.000002', completion: '0.00001' }, supported_parameters: ['response_format'] },
          { id: 'a/c', pricing: { prompt: '0', completion: '0' }, supported_parameters: [] },
        ],
      }),
    )
    const [model, ...rest] = await listModels('openrouter', 'key')
    expect(rest).toEqual([])
    expect(model.price?.input).toBeCloseTo(2)
    expect(model.price?.output).toBeCloseTo(10)
  })
})

describe('カスタムAPI', () => {
  const conn: Connection = { provider: 'custom', apiKey: '', model: 'local', baseUrl: 'http://127.0.0.1:8080/v1/' }

  it('指定のURLへキーなしで送る', async () => {
    const calls = stubFetch(() => dataStream([{ choices: [{ delta: { content: 'はい' }, finish_reason: 'stop' }] }]))
    const out = await complete(conn, req)
    expect(calls[0].url).toBe('http://127.0.0.1:8080/v1/chat/completions')
    expect(calls[0].headers.get('authorization')).toBeNull()
    expect(calls[0].body.max_tokens).toBe(16000)
    expect(out.text).toBe('はい')
    expect(out.costUsd).toBeUndefined()
  })
  it('キーがあれば付ける', async () => {
    const calls = stubFetch(() => dataStream([]))
    await complete({ ...conn, apiKey: 'dummy' }, req)
    expect(calls[0].headers.get('authorization')).toBe('Bearer dummy')
  })
  it('読める量を超えたときなどはサーバーの説明を見せる', () => {
    expect(explainError(new ProviderError(400, 'context size exceeded'))).toContain('context size exceeded')
  })
  it('Base URLの書き方の違いを吸収する', () => {
    expect(customBase('http://localhost:11434')).toBe('http://localhost:11434/v1')
    expect(customBase(' http://localhost:1234/v1/ ')).toBe('http://localhost:1234/v1')
    expect(customBase('http://localhost:1234/v1/chat/completions')).toBe('http://localhost:1234/v1')
  })
  it('URLでないものには送らない', async () => {
    const calls = stubFetch(() => dataStream([]))
    await expect(complete({ ...conn, baseUrl: '' }, req)).rejects.toThrow('API Base URL')
    expect(calls).toHaveLength(0)
  })
  it('接続できないときは確認する場所を伝える', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('Failed to fetch')
    })
    await expect(complete(conn, req)).rejects.toThrow(/CORS.*ローカルネットワーク/)
  })
  it('モデル一覧をキーなしで取得する', async () => {
    const calls = stubFetch(() => Response.json({ data: [{ id: 'local' }] }))
    expect(await listModels('custom', '', 'http://127.0.0.1:8080/v1')).toEqual([{ id: 'local' }])
    expect(calls[0].url).toBe('http://127.0.0.1:8080/v1/models')
  })
  it('設定のURLを接続に渡す', () => {
    const s = migrateSettings({ provider: 'custom', models: { custom: 'local' } }, false)
    expect(connectionFrom(s)).toMatchObject({ provider: 'custom', model: 'local', baseUrl: 'http://127.0.0.1:8080/v1' })
  })
})

describe('OpenRouterのログイン', () => {
  const storageWith = (verifier?: string) => {
    const items = new Map(verifier ? [['openrouter-pkce-verifier', verifier]] : [])
    return {
      getItem: (key: string) => items.get(key) ?? null,
      removeItem: (key: string) => void items.delete(key),
      items,
    }
  }

  it('RFC 7636 の例と同じチャレンジを作る', async () => {
    expect(await codeChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe(
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    )
  })
  it('ログインURLに戻り先とチャレンジを入れる', async () => {
    const url = new URL(await loginUrl('https://example.com/app/', 'verifier'))
    expect(url.origin + url.pathname).toBe('https://openrouter.ai/auth')
    expect(url.searchParams.get('callback_url')).toBe('https://example.com/app/')
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('code_challenge')).toBe(await codeChallenge('verifier'))
  })
  it('コードをキーに交換して保存する', async () => {
    const calls = stubFetch(() => Response.json({ key: 'sk-or-new' }))
    const storage = storageWith('verifier')
    expect(await finishOpenRouterLogin('?code=abc', storage)).toBe('ok')
    expect(calls[0].url).toBe('https://openrouter.ai/api/v1/auth/keys')
    expect(calls[0].body).toEqual({ code: 'abc', code_verifier: 'verifier', code_challenge_method: 'S256' })
    expect(storage.items.size).toBe(0)
    const settings = await getSettings()
    expect(settings.provider).toBe('openrouter')
    expect(settings.keys.openrouter).toBe('sk-or-new')
  })
  it('自分で始めていないログインは無視する', async () => {
    const calls = stubFetch(() => Response.json({ key: 'x' }))
    expect(await finishOpenRouterLogin('?code=abc', storageWith())).toBeNull()
    expect(await finishOpenRouterLogin('', storageWith('verifier'))).toBeNull()
    expect(calls).toHaveLength(0)
  })
  it('交換に失敗したら失敗を返す', async () => {
    stubFetch(() => new Response('{}', { status: 403 }))
    expect(await finishOpenRouterLogin('?code=abc', storageWith('verifier'))).toBe('failed')
  })
})

describe('公開版のAI', () => {
  it('公開版はClaude、OpenRouter、カスタムAPIだけにする', () => {
    expect(availableProviders(false).map((p) => p.id)).toEqual(['anthropic', 'openrouter', 'custom'])
    expect(availableProviders(true)).toHaveLength(5)
  })
  it('公開版で使えない会社が保存されていたらClaudeに戻す', () => {
    expect(migrateSettings({ provider: 'openai' }, false).provider).toBe('anthropic')
    expect(migrateSettings({ provider: 'openrouter' }, false).provider).toBe('openrouter')
    expect(migrateSettings({ provider: 'openai' }, true).provider).toBe('openai')
  })
})

describe('設定', () => {
  it('以前の Claude 用設定を引き継ぐ', () => {
    const s = migrateSettings({ apiKey: 'old', model: 'claude-haiku-5-5' })
    expect(s.provider).toBe('anthropic')
    expect(s.keys.anthropic).toBe('old')
    expect(connectionFrom(s)).toMatchObject({ apiKey: 'old', model: 'claude-haiku-5-5', price: { input: 0.1 } })
  })
  it('会社ごとにキーとモデルを切り替える', () => {
    const s = migrateSettings({
      provider: 'openai',
      keys: { anthropic: 'a', openai: 'b' },
      models: { openai: 'gpt-x' },
      prices: { 'openai:gpt-x': { input: 1, output: 2 } },
    })
    expect(connectionFrom(s)).toEqual({ provider: 'openai', apiKey: 'b', model: 'gpt-x', price: { input: 1, output: 2 } })
  })
  it('Claude以外は文字数から入力量を見積もる', async () => {
    const out = await estimate({ provider: 'openai', apiKey: 'k', model: 'm' }, { system: 'あ', user: 'い'.repeat(99) })
    expect(out.inputTokens).toBe(120)
    expect(out.usd).toBeUndefined()
  })
})

describe('parseJson', () => {
  it('前置きやコードブロックがあっても読める', () => {
    expect(parseJson('```json\n{"a":1}\n```')).toEqual({ a: 1 })
    expect(parseJson('結果です {"a":1}')).toEqual({ a: 1 })
  })
})
