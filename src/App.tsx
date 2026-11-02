import { Suspense, lazy, useCallback, useEffect, useRef, useState } from 'react'
import { finishOpenRouterLogin } from './analysis/openrouterLogin'
import { Loading } from './components/Loading'
import { db, getAccount, getKv, getSettings, setKv } from './db'
import type { Phase, SyncProgress } from './nostr/sync'
import { About } from './screens/About'
import { Home } from './screens/Home'

// スマートフォンの起動を軽くするため、ホーム以外の画面は開くときに読み込む
const Setup = lazy(() => import('./screens/Setup').then((m) => ({ default: m.Setup })))
const Timeline = lazy(() => import('./screens/Timeline').then((m) => ({ default: m.Timeline })))
const History = lazy(() => import('./screens/History').then((m) => ({ default: m.History })))
const Result = lazy(() => import('./screens/Result').then((m) => ({ default: m.Result })))
const SettingsScreen = lazy(() => import('./screens/Settings').then((m) => ({ default: m.SettingsScreen })))

export type SyncState = {
  running: boolean
  phases: Partial<Record<Phase, SyncProgress>>
  failed: string[]
  error?: string
}

export type Route =
  | { name: 'home' }
  | { name: 'timeline'; focus?: string }
  | { name: 'history' }
  | { name: 'settings' }
  | { name: 'about' }
  | { name: 'result'; id: number }

const NAV: [Route['name'], string][] = [
  ['home', 'ホーム'],
  ['timeline', 'タイムライン'],
  ['history', '履歴'],
  ['settings', '設定'],
  ['about', '説明'],
]

export function App() {
  const [account, setAccount] = useState<string | null | undefined>(undefined)
  const [route, setRoute] = useState<Route>({ name: 'home' })
  const [sync, setSync] = useState<SyncState>({ running: false, phases: {}, failed: [] })
  const [storageError, setStorageError] = useState(false)
  const [showAbout, setShowAbout] = useState(false)
  const [notice, setNotice] = useState('')
  const worker = useRef<Worker | null>(null)

  const startSync = useCallback(async (pubkey: string) => {
    if (worker.current) return
    const settings = await getSettings()
    const w = new Worker(new URL('./nostr/sync.worker.ts', import.meta.url), { type: 'module' })
    worker.current = w
    setSync({ running: true, phases: {}, failed: [] })
    const stop = () => {
      w.terminate()
      worker.current = null
    }
    w.onmessage = (ev) => {
      const msg = ev.data
      if (msg.type === 'progress') {
        const p: SyncProgress = msg.progress
        setSync((s) => ({ ...s, phases: { ...s.phases, [p.phase]: p }, failed: p.failed }))
      } else if (msg.type === 'done') {
        setSync((s) => ({ ...s, running: false, failed: msg.failed }))
        stop()
      } else {
        setSync((s) => ({ ...s, running: false, error: msg.message }))
        stop()
      }
    }
    w.onerror = (e) => {
      setSync((s) => ({ ...s, running: false, error: e.message }))
      stop()
    }
    w.postMessage({ pubkey, relays: settings.relays, tlDays: settings.tlDays })
  }, [])

  useEffect(() => {
    void (async () => {
      const login = await finishOpenRouterLogin(location.search, sessionStorage)
      if (login) {
        // URL に認可コードを残さない
        history.replaceState(null, '', location.pathname)
        setRoute({ name: 'settings' })
        setNotice(login === 'ok' ? 'OpenRouterにログインしました。モデルを選んでください。' : 'OpenRouterにログインできませんでした。もう一度試してください。')
      }
      const pubkey = (await getAccount()) ?? null
      setAccount(pubkey)
      // 前回の取得が途中なら続きから再開する
      if (pubkey && !(await getKv('syncedAt'))) void startSync(pubkey)
    })().catch(() => setStorageError(true))
  }, [startSync])

  if (storageError) {
    return (
      <main className="page">
        <section className="card setup">
          <h1>データを保存できません</h1>
          <p className="muted">
            このブラウザではデータを保存できないようです。プライベートブラウズを終了するか、別のブラウザで開いてください。
          </p>
        </section>
      </main>
    )
  }

  if (account === undefined) return <Loading />

  if (!account) {
    return (
      <main className="page">
        {showAbout ? (
          <About onBack={() => setShowAbout(false)} />
        ) : (
          <Suspense fallback={<Loading />}>
            <Setup
              onAbout={() => setShowAbout(true)}
              onStart={async (pubkey, verified) => {
                // ブラウザの容量が足りないときに取得データを自動で消されにくくする
                void navigator.storage?.persist?.()
                await setKv('account', pubkey)
                if (verified) await setKv('verifiedAccount', pubkey)
                setAccount(pubkey)
                void startSync(pubkey)
              }}
            />
          </Suspense>
        )}
      </main>
    )
  }

  return (
    <main className="page">
      <nav className="nav">
        {NAV.map(([name, label]) => (
          <button
            key={name}
            className={route.name === name ? 'nav-item active' : 'nav-item'}
            onClick={() => setRoute({ name } as Route)}
          >
            {label}
          </button>
        ))}
        {sync.running && <span className="nav-note">取得中…</span>}
      </nav>
      <Suspense fallback={<Loading />}>
        {route.name === 'home' && <Home sync={sync} account={account} go={setRoute} />}
        {route.name === 'timeline' && <Timeline key={route.focus} focus={route.focus} />}
        {route.name === 'history' && <History go={setRoute} />}
        {route.name === 'about' && <About />}
        {route.name === 'result' && <Result key={route.id} id={route.id} go={setRoute} />}
        {route.name === 'settings' && (
          <SettingsScreen
            sync={sync}
            notice={notice}
            onRefresh={() => startSync(account)}
            onReset={async () => {
              // 取得中のワーカーが削除後のDBへ書き込まないよう、先に止める
              worker.current?.terminate()
              worker.current = null
              await db.delete()
              await db.open()
              setAccount(null)
              setRoute({ name: 'home' })
              setSync({ running: false, phases: {}, failed: [] })
            }}
          />
        )}
      </Suspense>
    </main>
  )
}
