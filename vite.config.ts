import { defineConfig, type Plugin } from 'vitest/config'
import react from '@vitejs/plugin-react'

// APIキーをブラウザに置くので、許可した宛先以外へ通信できないようにする。開発時は Vite の仕組みと衝突するので本番だけ
const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "worker-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  // カスタムAPIは利用者のPCの中だけ許可する。画像サーバーは src/nostr/share.ts の IMAGE_SERVERS と同じもの
  "connect-src 'self' data: wss: https://api.anthropic.com https://openrouter.ai http://localhost:* http://127.0.0.1:* https://blossom.primal.net https://blossom.band",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ')

const contentSecurityPolicy = (): Plugin => ({
  name: 'content-security-policy',
  apply: 'build',
  transformIndexHtml: () => [
    { tag: 'meta', attrs: { 'http-equiv': 'Content-Security-Policy', content: CSP }, injectTo: 'head-prepend' },
  ],
})

// base を相対パスにして、どの静的ホスティングのサブパスにも置けるようにする
export default defineConfig({
  base: './',
  plugins: [react(), contentSecurityPolicy()],
  worker: { format: 'es' },
  // OneDrive 配下では変更通知を取りこぼし、古いコードを配信し続けることがある
  server: { watch: { usePolling: true, interval: 300 } },
  test: { environment: 'node' },
})
