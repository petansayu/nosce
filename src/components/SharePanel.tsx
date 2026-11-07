import { useEffect, useState } from 'react'
import { neventEncode } from 'nostr-tools/nip19'
import { IMAGE_SERVERS, SHARE_TAG, publish, shareEvent, shareRelays, uploadImage } from '../nostr/share'
import { SignerLogin, type HeldSigner } from './SignerLogin'
import { SITE } from '../site'

export type SheetImage = { blob: Blob; width: number; height: number }

const SHARE_PERMS = ['sign_event:22242', 'sign_event:1', 'sign_event:24242']

type Posted = { link: string; ok: number; failed: number }

export function SharePanel({
  title,
  account,
  makeImage,
  onClose,
}: {
  title: string
  account: string
  makeImage: () => Promise<SheetImage>
  onClose: () => void
}) {
  const [image, setImage] = useState<SheetImage>()
  const [preview, setPreview] = useState('')
  const [text, setText] = useState(`${title}\n\n#${SHARE_TAG}\n${SITE.url}`)
  const [server, setServer] = useState(IMAGE_SERVERS[0].url)
  const [signer, setSigner] = useState<HeldSigner>()
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [posted, setPosted] = useState<Posted>()

  useEffect(() => {
    let url = ''
    makeImage()
      .then((made) => {
        url = URL.createObjectURL(made.blob)
        setImage(made)
        setPreview(url)
      })
      .catch(() => setError('画像を作れませんでした。'))
    return () => URL.revokeObjectURL(url)
  }, [makeImage])

  // 署名アプリとの接続は、パネルを閉じたら切る
  useEffect(() => () => void signer?.close?.(), [signer])

  const post = async () => {
    if (!image || !signer) return
    setError('')
    try {
      setBusy('画像をアップロードしています…')
      const uploaded = await uploadImage(server, image.blob, image, signer)
      setBusy('投稿に署名してください…')
      const event = await signer.signEvent(shareEvent(text, uploaded))
      setBusy('リレーに送っています…')
      const result = await publish(event, await shareRelays())
      if (!result.ok.length) throw new Error('どのリレーにも投稿できませんでした。')
      setPosted({
        link: `https://njump.me/${neventEncode({ id: event.id, author: event.pubkey, relays: result.ok.slice(0, 2) })}`,
        ok: result.ok.length,
        failed: result.failed.length,
      })
    } catch (err) {
      setError(err instanceof Error && /[ぁ-ん]/.test(err.message) ? err.message : '投稿できませんでした。もう一度試してください。')
    } finally {
      setBusy('')
    }
  }

  if (posted) {
    return (
      <div className="share confirm card">
        <p>
          {posted.ok}個のリレーに投稿しました。
          {posted.failed > 0 && `${posted.failed}個のリレーには届きませんでした。`}
        </p>
        <div className="row wrap">
          <a href={posted.link} target="_blank" rel="noreferrer">
            投稿を見る
          </a>
          <button onClick={onClose}>閉じる</button>
        </div>
      </div>
    )
  }

  return (
    <div className="share confirm card">
      <h3>Nostrに共有</h3>
      {preview ? <img className="share-preview" src={preview} alt="共有する画像" /> : !error && <p className="muted small">画像を作っています…</p>}
      <p className="small">他の人の名前や投稿が写っていないか確認してください。画像は画像サーバーで公開され、あとから消すのは難しくなります。</p>
      <label className="field">
        本文
        <textarea rows={4} value={text} onChange={(e) => setText(e.target.value)} />
      </label>
      <label className="field">
        画像サーバー
        <select value={server} onChange={(e) => setServer(e.target.value)}>
          {IMAGE_SERVERS.map((s) => (
            <option key={s.url} value={s.url}>
              {s.label}({s.url.replace('https://', '')})
            </option>
          ))}
        </select>
      </label>
      {signer ? (
        <div className="row">
          <button className="primary" onClick={post} disabled={!image || !!busy}>
            投稿する
          </button>
          <button onClick={onClose} disabled={!!busy}>
            やめる
          </button>
        </div>
      ) : (
        <>
          <p className="muted small">投稿には署名が必要です。秘密鍵をこのアプリに渡すことはありません。</p>
          <SignerLogin expected={account} perms={SHARE_PERMS} keep verb="署名" onDone={(_, s) => setSigner(s)} />
          <button onClick={onClose}>やめる</button>
        </>
      )}
      {busy && <p className="small">{busy}</p>}
      {error && <p className="error">{error}</p>}
    </div>
  )
}
