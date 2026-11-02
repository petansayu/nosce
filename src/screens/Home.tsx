import { Suspense, lazy, useEffect, useRef, useState } from 'react'
import { db, getKv, getSettings, setKv, type ResultBody } from '../db'
import { complete, connectionFrom, estimate, explainError, formatCost, type LlmRequest } from '../analysis/llm'
import { PROVIDERS, type Connection } from '../analysis/providers'
import { ALL_PRESETS } from '../analysis/morePresets'
import { planRequest, type Prepared, type Preset, type QuestionPlan } from '../analysis/presets'
import { runInWorker } from '../analysis/presetJobs'
import { parseJson, toBody } from '../analysis/result'
import { Loading } from '../components/Loading'
import { SyncPanel } from '../components/SyncPanel'
import { formatTime } from '../analysis/prompt'
import type { Route, SyncState } from '../App'

const SignerLogin = lazy(() => import('../components/SignerLogin').then((m) => ({ default: m.SignerLogin })))

// 件数を数えるのは投稿が多いと重いので、取得中も間隔を空ける
const COUNT_INTERVAL = 15000

type Counts = { me: number; tl: number; first?: number; name?: string }

const GROUPS = [
  { title: 'AIで遊ぶ', free: false },
  { title: '無料で遊ぶ', free: true },
]

type Pending = {
  title: string
  presetId?: string
  question?: string
  prepared: Prepared
  estimateUsd?: number
  inputTokens: number
  providerLabel: string
}

export function Home({ sync, account, go }: { sync: SyncState; account: string; go: (r: Route) => void }) {
  const [counts, setCounts] = useState<Counts>()
  const [question, setQuestion] = useState('')
  const [pending, setPending] = useState<Pending>()
  const [busy, setBusy] = useState('')
  const [stream, setStream] = useState('')
  const [error, setError] = useState('')
  const [needProof, setNeedProof] = useState(false)
  const abort = useRef<AbortController | null>(null)

  useEffect(() => {
    // 前回の件数を先に出して、裏で数え直す
    void getKv<Counts>('homeCounts').then((saved) => saved && setCounts((current) => current ?? saved))
    const load = async () => {
      if (document.hidden) return
      const [me, total, first, profile] = await Promise.all([
        db.posts.where('[source+created_at]').between(['me', 0], ['me', Infinity]).count(),
        db.posts.count(),
        db.posts.where('[source+created_at]').between(['me', 0], ['me', Infinity]).first(),
        db.profiles.get(account),
      ])
      const next = { me, tl: total - me, first: first?.created_at, name: profile?.name }
      setCounts(next)
      await setKv('homeCounts', next)
    }
    void load()
    const t = sync.running ? setInterval(load, COUNT_INTERVAL) : undefined
    return () => clearInterval(t)
  }, [sync.running, account])

  const verified = async () => {
    await setKv('verifiedAccount', account)
    setNeedProof(false)
    setError('')
  }

  const needConnection = async () => {
    // 他の人のアカウントをAIに評価させないよう、本人だけに限る。手元の開発時は省く
    if (!import.meta.env.DEV && (await getKv('verifiedAccount')) !== account) {
      setNeedProof(true)
      return null
    }
    const conn = connectionFrom(await getSettings())
    const hasKey = conn.apiKey || conn.provider === 'custom'
    if (hasKey && conn.model) return conn
    setError(
      hasKey
        ? 'AIのモデルが選ばれていません。設定から選んでください。'
        : 'AIの分析にはAPIキーが必要です。設定から登録してください。',
    )
    return null
  }

  const confirm = async (title: string, prepared: Prepared, conn: Connection, extra: Partial<Pending>) => {
    if (!prepared.postCount) {
      setError('対象の投稿が見つかりませんでした。取得の完了を待つか、条件を変えてください。')
      return
    }
    const est = await estimate(conn, prepared.request)
    setPending({
      title,
      prepared,
      estimateUsd: est.usd,
      inputTokens: est.inputTokens,
      providerLabel: PROVIDERS.find((p) => p.id === conn.provider)!.label,
      ...extra,
    })
  }

  const startPreset = async (preset: Preset) => {
    setError('')
    setBusy(`${preset.title}を準備中…`)
    try {
      if (preset.free) {
        const body = await runInWorker<ResultBody>({ type: 'free', id: preset.id })
        const id = await db.results.add({
          title: preset.title,
          presetId: preset.id,
          createdAt: Date.now(),
          body,
          citations: {},
          postCount: counts?.me ?? 0,
          costUsd: 0,
        })
        go({ name: 'result', id })
        return
      }
      const conn = await needConnection()
      if (!conn) return
      const prepared = await runInWorker<Prepared>({ type: 'prepare', id: preset.id })
      await confirm(preset.title, prepared, conn, { presetId: preset.id })
    } catch (err) {
      setError(explainError(err))
    } finally {
      setBusy('')
    }
  }

  const ask = async () => {
    const q = question.trim()
    if (!q) {
      setError('質問を入力してください。')
      return
    }
    setError('')
    const conn = await needConnection()
    if (!conn) return
    setBusy('読む投稿を選んでいます…')
    try {
      const today = formatTime(Date.now() / 1000).slice(0, 10)
      const planned = await complete(conn, planRequest(q, today), undefined, undefined, 'low')
      const plan = parseJson(planned.text) as QuestionPlan
      const prepared = await runInWorker<Prepared>({ type: 'question', question: q, plan })
      await confirm(q, prepared, conn, { question: q })
    } catch (err) {
      setError(explainError(err))
    } finally {
      setBusy('')
    }
  }

  const run = async () => {
    if (!pending) return
    const job = pending
    const conn = connectionFrom(await getSettings())
    const request: LlmRequest = job.prepared.request
    setPending(undefined)
    setBusy(`${job.title}を作成中…`)
    setStream('')
    const controller = new AbortController()
    abort.current = controller
    try {
      const out = await complete(conn, request, request.schema ? undefined : setStream, controller.signal)
      if (request.schema && out.truncated) {
        throw new Error('AIの返答が長すぎて途中で切れました。もう一度試すか、別のモデルを選んでください。')
      }
      const id = await db.results.add({
        title: job.title,
        presetId: job.presetId,
        question: job.question,
        createdAt: Date.now(),
        body: toBody(out.text, job.prepared.kind, job.prepared.meta),
        citations: job.prepared.citations,
        postCount: job.prepared.postCount,
        costUsd: out.costUsd ?? 0,
        tokens: { input: out.inputTokens, output: out.outputTokens },
        truncated: out.truncated,
      })
      go({ name: 'result', id })
    } catch (err) {
      if (!controller.signal.aborted) setError(explainError(err))
    } finally {
      setBusy('')
      setStream('')
    }
  }

  return (
    <>
      <section className="card">
        <p className="muted small">
          {counts?.name ?? 'あなた'} ・ 自分の投稿 {(counts?.me ?? 0).toLocaleString()}件 ・ TL{' '}
          {(counts?.tl ?? 0).toLocaleString()}件
          {counts?.first ? ` ・ ${formatTime(counts.first).slice(0, 10)}から` : ''}
        </p>
        <div className="row">
          <input
            value={question}
            onChange={(e) => {
              setQuestion(e.target.value)
              setError('')
            }}
            onKeyDown={(e) => e.key === 'Enter' && !busy && ask()}
            placeholder="去年の冬、何に一番ハマってた?"
            aria-label="質問"
          />
          <button className="primary" onClick={ask} disabled={!!busy}>
            聞く
          </button>
        </div>
        {error && (
          <p className="error">
            {error}
            {error.includes('設定') && (
              <button className="link" onClick={() => go({ name: 'settings' })}>
                設定を開く
              </button>
            )}
          </p>
        )}
      </section>

      {needProof && (
        <section className="card confirm">
          <h2>本人確認</h2>
          <p className="muted small">AI分析は、アカウントの持ち主だけが使えます。確認すると、もう一度プリセットを押せます。</p>
          <Suspense fallback={<Loading />}>
            <SignerLogin expected={account} onDone={verified} />
          </Suspense>
        </section>
      )}

      {pending && (
        <section className="card confirm">
          <h2>{pending.title}</h2>
          <p>
            投稿 {pending.prepared.postCount.toLocaleString()}件を読みます。入力 約
            {pending.inputTokens.toLocaleString()}トークン、
            {pending.estimateUsd === undefined
              ? '費用は選んだモデルの料金によります。'
              : `費用の目安は ${formatCost(pending.estimateUsd)} です。`}
          </p>
          <p className="muted small">
            投稿の一部が{pending.providerLabel}に送られます。他の人の投稿を含むことがあります。
          </p>
          <div className="row">
            <button className="primary" onClick={run}>
              実行する
            </button>
            <button onClick={() => setPending(undefined)}>やめる</button>
          </div>
        </section>
      )}

      {busy && (
        <section className="card">
          <div className="row spread">
            <p>{busy}</p>
            {abort.current && !abort.current.signal.aborted && stream && (
              <button onClick={() => abort.current?.abort()}>止める</button>
            )}
          </div>
          {stream && <pre className="stream">{stream}</pre>}
        </section>
      )}

      {GROUPS.map(({ title, free }) => (
        <div key={title}>
          <h2 className="section">{title}</h2>
          <div className="grid">
            {ALL_PRESETS.filter((p) => !!p.free === free).map((p) => (
              <button key={p.id} className="preset" onClick={() => startPreset(p)} disabled={!!busy}>
                <b>{p.title}</b>
                <span className="muted small">{p.desc}</span>
                <span className={p.free ? 'tag free' : 'tag'}>{p.free ? '無料' : 'AI'}</span>
              </button>
            ))}
          </div>
        </div>
      ))}

      {(sync.running || sync.error || sync.failed.length > 0) && (
        <>
          <h2 className="section">データの取得</h2>
          <section className="card">
            <SyncPanel sync={sync} />
            {sync.error && <p className="error">取得を中断しました: {sync.error}</p>}
            {sync.failed.length > 0 && (
              <p className="muted small">つながらなかったリレー: {sync.failed.join(', ')}(次回の更新で再試行します)</p>
            )}
          </section>
        </>
      )}
    </>
  )
}
