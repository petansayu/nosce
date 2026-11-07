import { SimplePool } from 'nostr-tools/pool'
import type { Event, EventTemplate } from 'nostr-tools/pure'
import { getKv, getSettings } from '../db'
import type { Signer } from './identity'
import { normalizeRelays } from './relays'

// ブラウザからのアップロードを許可している Blossom サーバー。CSP の connect-src にも同じものを入れる
export const IMAGE_SERVERS = [
  { url: 'https://blossom.primal.net', label: 'Primal' },
  { url: 'https://blossom.band', label: 'nostr.build' },
]

export const SHARE_TAG = 'じぶん分析'

// Blossom の認証(kind 24242)の有効期限
const AUTH_SECONDS = 300
const PUBLISH_WAIT_MS = 8000

export type UploadedImage = { url: string; sha256: string; type: string; width: number; height: number }

export async function sha256Hex(blob: Blob) {
  const hash = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer())
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

const now = () => Math.floor(Date.now() / 1000)

// btoa は日本語を扱えないので、UTF-8 のバイト列にしてから変換する
const base64 = (text: string) => btoa(String.fromCharCode(...new TextEncoder().encode(text)))

// BUD-02 の PUT /upload。認証イベントは Authorization ヘッダーに base64 で載せる
export async function uploadImage(
  server: string,
  blob: Blob,
  size: { width: number; height: number },
  signer: Pick<Signer, 'signEvent'>,
): Promise<UploadedImage> {
  const sha256 = await sha256Hex(blob)
  const auth = await signer.signEvent({
    kind: 24242,
    created_at: now(),
    tags: [
      ['t', 'upload'],
      ['x', sha256],
      ['expiration', String(now() + AUTH_SECONDS)],
    ],
    content: `${SHARE_TAG} の画像をアップロード`,
  })
  const res = await fetch(`${server}/upload`, {
    method: 'PUT',
    headers: {
      authorization: `Nostr ${base64(JSON.stringify(auth))}`,
      'content-type': blob.type,
      'x-sha-256': sha256,
    },
    body: blob,
  })
  if (!res.ok) {
    const reason = res.headers.get('x-reason') ?? (await res.text().catch(() => '')).slice(0, 100)
    throw new Error(`画像をアップロードできませんでした(${res.status})。${reason}`)
  }
  const data = (await res.json()) as { url?: string; sha256?: string; type?: string }
  if (!data.url?.startsWith('https://')) throw new Error('画像サーバーの返答を読み取れませんでした。')
  return { url: data.url, sha256: data.sha256 ?? sha256, type: data.type ?? blob.type, width: size.width, height: size.height }
}

// 本文の #ハッシュタグを t タグにし、画像は NIP-92 の imeta で寸法を伝える
export function shareEvent(text: string, image: UploadedImage): EventTemplate {
  const tags = [...new Set([...text.matchAll(/#([^\s#]+)/gu)].map((m) => m[1].toLowerCase()))].map((t) => ['t', t])
  return {
    kind: 1,
    created_at: now(),
    tags: [
      ...tags,
      ['imeta', `url ${image.url}`, `m ${image.type}`, `x ${image.sha256}`, `dim ${image.width}x${image.height}`],
    ],
    content: `${text.trim()}\n${image.url}`,
  }
}

// 自分のリレーリストの書き込み先と、設定の基本のリレーに送る
export async function shareRelays() {
  const [settings, write] = await Promise.all([getSettings(), getKv<string[]>('writeRelays')])
  return normalizeRelays([...(write ?? []), ...settings.relays])
}

export async function publish(event: Event, relays: string[]) {
  const pool = new SimplePool()
  try {
    const results = await Promise.allSettled(pool.publish(relays, event, { maxWait: PUBLISH_WAIT_MS }))
    return {
      ok: relays.filter((_, i) => results[i].status === 'fulfilled'),
      failed: relays.filter((_, i) => results[i].status === 'rejected'),
    }
  } finally {
    pool.destroy()
  }
}
