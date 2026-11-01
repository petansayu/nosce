import Dexie, { type Table } from 'dexie'
import { availableProviders } from './analysis/providers'

export type Post = {
  id: string
  pubkey: string
  created_at: number
  content: string
  source: 'me' | 'tl'
  replyTo?: string
  mentions: string[]
}

// 自分宛ての返信・リアクション・リポスト・zap
export type Incoming = {
  id: string
  kind: number
  pubkey: string
  created_at: number
  target?: string
  content?: string
}

export type Profile = { pubkey: string; name: string; updatedAt: number }

export type Cursor = {
  key: string
  from?: number
  to?: number
  pending?: { until: number; low: number; high: number }
}

export type Tombstone = { id: string; pubkey: string }

export type AppraisalItem = {
  label: string
  value: string
  reason: string
  confidence: '高' | '中' | '低' | '不明'
  evidence: string[]
  check?: 'hit' | 'miss'
}

export type Paper = {
  headline: string
  subhead: string
  lead: string
  leadEvidence: string[]
  articles: { section: string; title: string; body: string; evidence: string[] }[]
  column: { title: string; body: string; evidence: string[] }
  weather: string
  letter: { from: string; body: string }
}

export type NewspaperMeta = { issueNo: number; daily: { label: string; count: number }[] }

export type Award = {
  title: string
  citation: string
  evidence: string[]
  runnersUp: { name: string; reason: string }[]
}

export type DriftExample = { quote: string; evidence: string }

export type Drift = {
  score: number
  verdict: string
  flowed: number
  own: number
  neutral: number
  comment: string
  flowedExamples: DriftExample[]
  ownExamples: DriftExample[]
}

export type Dialogue = {
  title: string
  lead: string
  lines: { speaker: 'past' | 'now'; text: string }[]
  closing: string
  evidence: string[]
}

export type ResultKind = 'newspaper' | 'appraisal' | 'award' | 'drift' | 'dialogue' | 'sheet'

export type ResultBody =
  | { type: 'text'; text: string }
  // presetId で紙面を選ぶ汎用の結果
  | { type: 'sheet'; data: unknown }
  | { type: 'appraisal'; items: AppraisalItem[] }
  | { type: 'award'; award: Award }
  | { type: 'drift'; drift: Drift }
  | { type: 'dialogue'; dialogue: Dialogue }
  | ({ type: 'newspaper'; paper: Paper } & NewspaperMeta)
  | { type: 'power'; data: unknown }
  | { type: 'words'; data: unknown }

export type SavedResult = {
  id?: number
  title: string
  presetId?: string
  question?: string
  createdAt: number
  body: ResultBody
  citations: Record<string, string>
  postCount: number
  costUsd: number
  tokens?: { input: number; output: number }
  truncated?: boolean
}

export type ProviderId = 'anthropic' | 'openai' | 'gemini' | 'openrouter' | 'custom'

export type Settings = {
  relays: string[]
  provider: ProviderId
  keys: Partial<Record<ProviderId, string>>
  models: Partial<Record<ProviderId, string>>
  // カスタムAPI(OpenAI互換)の Base URL
  customUrl: string
  // "provider:model" ごとの料金(100万トークンあたりのドル)。一覧にない会社は利用者が入力する
  prices: Record<string, { input: number; output: number }>
  tlDays: number
}

export const DEFAULT_RELAYS = [
  'wss://yabu.me',
  'wss://relay-jp.nostr.wirednet.jp',
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.primal.net',
]

export const DEFAULT_SETTINGS: Settings = {
  relays: DEFAULT_RELAYS,
  provider: 'anthropic',
  keys: {},
  models: { anthropic: 'claude-opus-5-5' },
  customUrl: 'http://127.0.0.1:8080/v1',
  prices: {},
  tlDays: 90,
}

class AppDB extends Dexie {
  posts!: Table<Post, string>
  incoming!: Table<Incoming, string>
  profiles!: Table<Profile, string>
  cursors!: Table<Cursor, string>
  tombstones!: Table<Tombstone, string>
  results!: Table<SavedResult, number>
  kv!: Table<{ key: string; value: unknown }, string>

  constructor() {
    super('jibun-bunseki')
    this.version(1).stores({
      posts: 'id, created_at, [source+created_at], pubkey',
      incoming: 'id, target, kind',
      profiles: 'pubkey',
      cursors: 'key',
      tombstones: 'id',
      results: '++id, createdAt',
      kv: 'key',
    })
    this.version(2).stores({ incoming: 'id, target, kind, created_at' })
  }
}

export const db = new AppDB()

export async function getKv<T>(key: string): Promise<T | undefined> {
  return (await db.kv.get(key))?.value as T | undefined
}

export async function setKv(key: string, value: unknown) {
  await db.kv.put({ key, value })
}

type StoredSettings = Partial<Settings> & { apiKey?: string; model?: string }

// 以前の設定は Claude 用の apiKey と model だけを持っていた
export function migrateSettings(stored: StoredSettings = {}, dev?: boolean): Settings {
  const { apiKey, model, ...rest } = stored
  const usable = availableProviders(dev).some((p) => p.id === rest.provider)
  return {
    ...DEFAULT_SETTINGS,
    ...rest,
    provider: usable ? rest.provider! : DEFAULT_SETTINGS.provider,
    keys: { ...(apiKey ? { anthropic: apiKey } : {}), ...rest.keys },
    models: { ...DEFAULT_SETTINGS.models, ...(model ? { anthropic: model } : {}), ...rest.models },
  }
}

export async function getSettings(): Promise<Settings> {
  return migrateSettings(await getKv<StoredSettings>('settings'))
}

export async function saveSettings(patch: Partial<Settings>) {
  await setKv('settings', { ...(await getSettings()), ...patch })
}

export async function getAccount() {
  return getKv<string>('account')
}

export async function profileNames(): Promise<Map<string, string>> {
  const rows = await db.profiles.toArray()
  return new Map(rows.map((p) => [p.pubkey, p.name]))
}

export async function ownPosts() {
  return db.posts
    .where('[source+created_at]')
    .between(['me', Dexie.minKey], ['me', Dexie.maxKey])
    .toArray()
}

export async function postsInRange(source: 'me' | 'tl', from: number, to: number) {
  return db.posts.where('[source+created_at]').between([source, from], [source, to], true, true).toArray()
}
