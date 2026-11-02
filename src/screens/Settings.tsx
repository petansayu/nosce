import { useEffect, useState } from 'react'
import { db, getSettings, saveSettings, type ProviderId, type Settings } from '../db'
import { CLAUDE_MODELS, explainError } from '../analysis/llm'
import { startOpenRouterLogin } from '../analysis/openrouterLogin'
import { PROVIDERS, availableProviders, listModels, type ModelInfo } from '../analysis/providers'
import { normalizeRelays } from '../nostr/relays'
import { Loading } from '../components/Loading'
import { SyncPanel } from '../components/SyncPanel'
import type { SyncState } from '../App'

function download(name: string, text: string) {
  const a = document.createElement('a')
  a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' }))
  a.download = name
  a.click()
  URL.revokeObjectURL(a.href)
}

export function SettingsScreen({
  sync,
  notice,
  onRefresh,
  onReset,
}: {
  sync: SyncState
  notice: string
  onRefresh: () => void
  onReset: () => void
}) {
  const [s, setS] = useState<Settings>()
  const [relayText, setRelayText] = useState('')
  const [saved, setSaved] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [models, setModels] = useState<ModelInfo[]>([])
  const [loading, setLoading] = useState(false)
  const [listError, setListError] = useState('')

  useEffect(() => {
    void getSettings().then((v) => {
      setS(v)
      setRelayText(v.relays.join('\n'))
    })
  }, [])

  if (!s) return <Loading />

  const update = (patch: Partial<Settings>) => {
    setS({ ...s, ...patch })
    setSaved(false)
  }

  const provider = PROVIDERS.find((p) => p.id === s.provider)!
  const custom = s.provider === 'custom'
  const apiKey = s.keys[s.provider] ?? ''
  const model = s.models[s.provider] ?? ''
  const priceKey = `${s.provider}:${model}`
  const price = s.prices[priceKey]

  const pickModel = (id: string) => {
    const listed = models.find((m) => m.id === id)?.price
    update({
      models: { ...s.models, [s.provider]: id },
      prices: listed ? { ...s.prices, [`${s.provider}:${id}`]: listed } : s.prices,
    })
  }

  const setPrice = (patch: { input?: string; output?: string }) => {
    const next = { input: price?.input ?? 0, output: price?.output ?? 0 }
    if (patch.input !== undefined) next.input = Number(patch.input)
    if (patch.output !== undefined) next.output = Number(patch.output)
    update({ prices: { ...s.prices, [priceKey]: next } })
  }

  const fetchModels = async () => {
    if (!apiKey && !custom) {
      setListError('先にAPIキーを入力してください。')
      return
    }
    setLoading(true)
    setListError('')
    try {
      setModels(await listModels(s.provider, apiKey, s.customUrl))
    } catch (err) {
      setListError(explainError(err))
    } finally {
      setLoading(false)
    }
  }

  const save = async () => {
    const relays = normalizeRelays(relayText.split(/\s+/).filter(Boolean))
    await saveSettings({ ...s, relays })
    setRelayText(relays.join('\n'))
    setSaved(true)
  }

  const login = async () => {
    await save()
    await startOpenRouterLogin()
  }

  const exportAll = async () => {
    const [posts, incoming, results] = await Promise.all([
      db.posts.toArray(),
      db.incoming.toArray(),
      db.results.toArray(),
    ])
    download('jibun-bunseki.json', JSON.stringify({ posts, incoming, results }))
  }

  return (
    <>
      <section className="card">
        <h2>AI</h2>
        {notice && <p className="notice">{notice}</p>}
        <label className="field">
          使うAI
          <select
            value={s.provider}
            onChange={(e) => {
              update({ provider: e.target.value as ProviderId })
              setModels([])
              setListError('')
            }}
          >
            {availableProviders().map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
        </label>
        {s.provider === 'openrouter' && (
          <div className="login">
            <button className="primary" onClick={login}>
              OpenRouterでログイン
            </button>
            <p className="muted small">おすすめの方法です。キーを貼り付けなくても使えます。</p>
          </div>
        )}
        {custom && (
          <label className="field">
            API Base URL
            <input
              type="url"
              value={s.customUrl}
              onChange={(e) => update({ customUrl: e.target.value })}
              placeholder="http://127.0.0.1:8080/v1"
              autoComplete="off"
            />
          </label>
        )}
        <label className="field">
          {s.provider === 'openrouter' ? 'またはAPIキーを入力' : custom ? 'APIキー(任意)' : 'APIキー'}
          <input
            type="password"
            value={apiKey}
            onChange={(e) => update({ keys: { ...s.keys, [s.provider]: e.target.value } })}
            placeholder={provider.keyHint}
            autoComplete="off"
          />
        </label>
        {custom ? (
          <p className="muted small">キーはこのブラウザにだけ保存し、この接続先への通信にだけ使います。書き出しには含めません。</p>
        ) : (
          <p className="muted small">
            <a href={provider.keyUrl} target="_blank" rel="noreferrer">
              APIキーを発行する
            </a>
            。キーはこのブラウザにだけ保存し、選んだAIの会社への通信にだけ使います。書き出しには含めません。
          </p>
        )}
        <p className="muted small">{provider.note}</p>

        {s.provider === 'anthropic' ? (
          <label className="field">
            モデル
            <select value={model} onChange={(e) => update({ models: { ...s.models, anthropic: e.target.value } })}>
              {CLAUDE_MODELS.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}(入力${m.input} / 出力${m.output} 100万トークンあたり)
                </option>
              ))}
            </select>
          </label>
        ) : (
          <>
            <label className="field">
              モデル
              <div className="row">
                <input
                  list="model-list"
                  value={model}
                  onChange={(e) => pickModel(e.target.value)}
                  placeholder="一覧から選ぶか、モデル名を入力"
                />
                <button onClick={fetchModels} disabled={loading}>
                  {loading ? '取得中…' : '一覧を取得'}
                </button>
              </div>
              <datalist id="model-list">
                {models.map((m) => (
                  <option key={m.id} value={m.id} />
                ))}
              </datalist>
            </label>
            {listError && <p className="error">{listError}</p>}
            {models.length > 0 && <p className="muted small">{models.length}個のモデルが見つかりました。</p>}
            {!custom && (
              <>
                <div className="row">
                  <label className="field">
                    入力の料金(任意)
                    <input
                      type="number"
                      min={0}
                      step="any"
                      value={price?.input ?? ''}
                      onChange={(e) => setPrice({ input: e.target.value })}
                      placeholder="$ / 100万トークン"
                    />
                  </label>
                  <label className="field">
                    出力の料金(任意)
                    <input
                      type="number"
                      min={0}
                      step="any"
                      value={price?.output ?? ''}
                      onChange={(e) => setPrice({ output: e.target.value })}
                      placeholder="$ / 100万トークン"
                    />
                  </label>
                </div>
                <p className="muted small">料金を入れると、費用の目安を計算します。空のままでも使えます。</p>
              </>
            )}
          </>
        )}

        <h2>データ</h2>
        <label className="field">
          TLの取得日数
          <input
            type="number"
            min={1}
            max={1500}
            step={1}
            value={s.tlDays}
            onChange={(e) => update({ tlDays: Math.max(1, Math.round(Number(e.target.value)) || 1) })}
          />
        </label>
        <label className="field">
          基本のリレー(1行に1つ)
          <textarea rows={5} value={relayText} onChange={(e) => {
              setRelayText(e.target.value)
              setSaved(false)
            }} />
        </label>
        <p className="muted small">各自のリレーリスト(kind 10002)も自動で使います。</p>
        <div className="row">
          <button className="primary" onClick={save}>
            保存
          </button>
          {saved && <span className="muted small">保存しました</span>}
        </div>
      </section>

      <section className="card">
        <h2>取得</h2>
        {sync.running && <SyncPanel sync={sync} />}
        <div className="row wrap">
          <button onClick={onRefresh} disabled={sync.running}>
            今すぐ更新
          </button>
          <button onClick={exportAll}>書き出し</button>
          {!confirming && <button onClick={() => setConfirming(true)}>全削除</button>}
        </div>
        {confirming && (
          <div className="confirm">
            <p>投稿、分析履歴、APIキーをこのブラウザから消します。元に戻せません。</p>
            <div className="row">
              <button className="danger" onClick={onReset}>
                全削除する
              </button>
              <button onClick={() => setConfirming(false)}>やめる</button>
            </div>
          </div>
        )}
      </section>
    </>
  )
}
