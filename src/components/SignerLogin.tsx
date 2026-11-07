import { useEffect, useRef, useState } from 'react'
import { identify, type Signer } from '../nostr/identity'
import { connectBunker, createConnectRequest, waitForSigner } from '../nostr/remoteSigner'

const NOT_OWNER = 'このアカウントの鍵で署名してください。'

export type HeldSigner = Signer & { close?: () => Promise<void> }

// keep のときは署名アプリとの接続を閉じずに渡す。閉じるのは受け取った側
export function SignerLogin({
  expected,
  onDone,
  perms,
  keep = false,
  verb = '確認',
}: {
  expected?: string
  onDone: (pubkey: string, signer: HeldSigner) => void
  perms?: string[]
  keep?: boolean
  verb?: string
}) {
  const [connectUri, setConnectUri] = useState('')
  const [bunker, setBunker] = useState('')
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [copied, setCopied] = useState(false)
  const abort = useRef<AbortController | null>(null)

  useEffect(() => () => abort.current?.abort(), [])

  const finish = async (signer: HeldSigner) => {
    setBusy('署名を承認してください…')
    const pubkey = await identify(signer, expected)
    if (pubkey) onDone(pubkey, signer)
    else setError(NOT_OWNER)
    if (!keep || !pubkey) await signer.close?.()
  }

  const run = async (start: () => Promise<void>) => {
    setError('')
    try {
      await start()
    } catch (err) {
      if (abort.current?.signal.aborted) return
      setError(err instanceof Error && /[ぁ-ん]/.test(err.message) ? err.message : '確認できませんでした。もう一度試してください。')
    } finally {
      setBusy('')
    }
  }

  const useExtension = () =>
    run(async () => {
      if (!window.nostr) throw new Error('NIP-07対応の拡張機能が見つかりません。')
      await finish(window.nostr)
    })

  const useApp = () => {
    abort.current?.abort()
    const controller = new AbortController()
    abort.current = controller
    const request = createConnectRequest(perms)
    setConnectUri(request.uri)
    void run(async () => {
      setBusy('署名アプリの接続を待っています…')
      const signer = await waitForSigner(request, controller.signal)
      await finish(signer)
    })
  }

  const useBunker = () =>
    run(async () => {
      setBusy('接続しています…')
      const signer = await connectBunker(bunker)
      await finish(signer)
    })

  const copy = async () => {
    await navigator.clipboard.writeText(connectUri)
    setCopied(true)
  }

  return (
    <div className="signer">
      <div className="row wrap">
        <button className="primary" onClick={useExtension}>
          拡張機能で{verb}
        </button>
        <button onClick={useApp}>署名アプリで{verb}</button>
      </div>
      <p className="muted small">パソコンはNIP-07の拡張機能、スマホはAmberなどの署名アプリが使えます。</p>

      {connectUri && (
        <div className="signer-connect">
          <a className="signer-open" href={connectUri}>
            署名アプリを開く
          </a>
          <button onClick={copy}>{copied ? 'コピーしました' : '接続用の文字列をコピー'}</button>
          <p className="muted small">アプリで承認したら、この画面に戻ってください。</p>
        </div>
      )}

      <details>
        <summary className="muted small">bunker:// で接続する</summary>
        <div className="row">
          <input
            value={bunker}
            onChange={(e) => setBunker(e.target.value)}
            placeholder="bunker://..."
            aria-label="bunker接続文字列"
            autoComplete="off"
          />
          <button onClick={useBunker}>接続</button>
        </div>
      </details>

      {busy && <p className="small">{busy}</p>}
      {error && <p className="error">{error}</p>}
    </div>
  )
}
