import { BunkerSigner, createNostrConnectURI, parseBunkerInput } from 'nostr-tools/nip46'
import { SimplePool } from 'nostr-tools/pool'
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { SITE } from '../site'

// 署名アプリとの連絡に使うリレー
const CONNECT_RELAYS = ['wss://relay.nsec.app', 'wss://relay.damus.io', 'wss://nos.lol']
// 利用者がアプリで承認するのを待つ
const APPROVE_TIMEOUT_MS = 3 * 60_000

// スマホでアプリを切り替えると接続が切れるので、戻ったときに繋ぎ直す
const newPool = () => new SimplePool({ enablePing: true, enableReconnect: true })

// 本人確認(22242)だけなら既定のまま。共有では投稿(1)と画像の認証(24242)も頼む
export function createConnectRequest(perms = ['sign_event:22242']) {
  const secretKey = generateSecretKey()
  const uri = createNostrConnectURI({
    clientPubkey: getPublicKey(secretKey),
    relays: CONNECT_RELAYS,
    secret: crypto.randomUUID(),
    name: SITE.name,
    url: SITE.url,
    perms,
  })
  return { secretKey, uri }
}

export function waitForSigner(request: ReturnType<typeof createConnectRequest>, signal: AbortSignal) {
  return BunkerSigner.fromURI(
    request.secretKey,
    request.uri,
    { pool: newPool(), timeout: APPROVE_TIMEOUT_MS, onauth: openAuthPage },
    signal,
  )
}

export async function connectBunker(input: string) {
  const pointer = await parseBunkerInput(input.trim())
  if (!pointer) throw new Error('bunker:// で始まる接続文字列を入力してください。')
  const signer = BunkerSigner.fromBunker(generateSecretKey(), pointer, {
    pool: newPool(),
    timeout: APPROVE_TIMEOUT_MS,
    onauth: openAuthPage,
  })
  await signer.connect()
  return signer
}

function openAuthPage(url: string) {
  // 署名サービスが承認ページを開くよう求めたとき。https 以外は開かない
  if (url.startsWith('https://')) window.open(url, '_blank', 'noopener')
}
