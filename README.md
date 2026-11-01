# じぶん分析 for Nostr

自分のkind1とTLから、自分をネタにして遊ぶブラウザアプリです。サーバーはなく、データはブラウザ内(IndexedDB)に保存します。必要なのはnpubだけで、秘密鍵は使いません。

## 起動

```bash
npm install
npm run dev
```

## 確認

```bash
npm test
npm run build
```

`npm run build` の `dist` は静的サイトとして公開できます。公開の前に [PUBLISHING.md](PUBLISHING.md) を確認してください。

## 構成

- `src/nostr`: リレーからの取得。ワーカーで動き、取得範囲をカーソルに残して中断から再開する
- `src/analysis`: 統計、投稿の抽出、Claudeへの依頼、プリセット
- `src/screens`: 画面

## ライセンス

[MIT](LICENSE)

## AI分析

公開版はClaude、OpenRouter、カスタムAPI(OpenAI互換)から選べます。カスタムAPIはllama.cpp、Ollama、LM Studio、vLLMなどのローカルLLM用で、公開版から接続できるのは `localhost` と `127.0.0.1` だけです。手元の開発版(`npm run dev`)では、ChatGPTとGeminiも使えます。理由は [PUBLISHING.md](PUBLISHING.md) にまとめています。

利用者自身のAPIキーをブラウザに保存し、ブラウザから直接各社のAPIを呼びます。投稿の全量は送らず、抽出した分だけを送ります。

Claudeのモデルと料金は [src/analysis/llm.ts](src/analysis/llm.ts) に2026年10月時点の単価で持っています。他社のモデルは入れ替わりが早いので、設定画面から各社のモデル一覧を取得します。OpenRouterは一覧の料金を使い、OpenAIとGeminiは利用者が料金を入れたときだけ費用を計算します。
