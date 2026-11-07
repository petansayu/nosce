import { verifyEvent, type Event } from 'nostr-tools/pure'
import type { Filter } from 'nostr-tools/filter'
import { db, setKv, type Post } from '../db'
import { displayName, newest, parseFollows, saveEvents } from './events'
import { normalizeRelays, parseRelayList, planRelays } from './relays'
import { RelayPool } from './transport'
import { walkRange } from './walk'

export type SyncConfig = { pubkey: string; relays: string[]; tlDays: number }

export type Phase = 'discovery' | 'me' | 'incoming' | 'tl'

export type SyncProgress = {
  phase: Phase
  ratio: number
  count: number
  failed: string[]
  scanned?: number
  jobsDone?: number
  jobs?: number
}

// Nostrの実質的な開始時期。自分の全投稿を読むときの下限
const NOSTR_EPOCH = Date.UTC(2020, 10, 1) / 1000
const OVERLAP = 3600
const AUTHORS_PER_FILTER = 100
const PAGE_GAP_MS = 150
// 重複だけのページがこれだけ続いたら、そのリレーは取得済みの範囲を飛ばす
const IDLE_PAGES = 6
// 遅いリレーが1つあっても、他のリレーと次の段階を止めないよう並行して読む
const PHASE_CONCURRENCY = 3

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function hash(text: string) {
  let h = 0
  for (const c of text) h = (Math.imul(h, 31) + c.charCodeAt(0)) | 0
  return (h >>> 0).toString(36)
}

type Job = {
  key: string
  relay: string
  filter: Filter
  lower: number
  save: (events: Event[]) => Promise<number>
  // 複数のリレーに同じ投稿があるとき、ここより新しい範囲は読み直さず、古い投稿だけ確認する
  oldestKnown?: () => Promise<number | undefined>
}

export const nextAfterIdle = (idlePages: number, nextUntil: number, oldest: number | undefined) =>
  idlePages >= IDLE_PAGES && oldest !== undefined && oldest < nextUntil ? oldest : undefined

// 取得済みの範囲をカーソルに残し、中断しても未取得の範囲だけ読み直す
async function runJob(
  pool: RelayPool,
  job: Job,
  now: number,
  onRatio: (r: number) => void,
  onSaved: (added: number, scanned: number) => void,
) {
  const fetchPage = (f: Filter) => pool.query(job.relay, f)
  const cursor = (await db.cursors.get(job.key)) ?? { key: job.key }

  const range = async (high: number, low: number) => {
    let idlePages = 0
    await walkRange(fetchPage, job.filter, high, low, async (events, nextUntil) => {
      const added = await job.save(events)
      onSaved(added, events.length)
      idlePages = added ? 0 : idlePages + 1
      const jump = nextAfterIdle(idlePages, nextUntil, await job.oldestKnown?.())
      if (jump !== undefined) idlePages = 0
      const until = jump ?? nextUntil
      cursor.pending = { until, low, high }
      await db.cursors.put(cursor)
      onRatio((high - Math.max(until, low)) / Math.max(high - low, 1))
      await sleep(PAGE_GAP_MS)
      return until
    })
    cursor.from = Math.min(cursor.from ?? low, low)
    cursor.to = Math.max(cursor.to ?? high, high)
    cursor.pending = undefined
    await db.cursors.put(cursor)
  }

  if (cursor.pending) {
    const { until, low, high } = cursor.pending
    await walkAndMerge(until, low, high)
  }
  if (cursor.to === undefined) {
    await range(now, job.lower)
  } else {
    await range(now, cursor.to - OVERLAP)
    if (job.lower < cursor.from!) await range(cursor.from!, job.lower)
  }
  onRatio(1)

  async function walkAndMerge(until: number, low: number, high: number) {
    await range(until, low)
    cursor.to = Math.max(cursor.to ?? high, high)
    await db.cursors.put(cursor)
  }
}

async function runPhase(
  pool: RelayPool,
  phase: Phase,
  jobs: Job[],
  concurrency: number,
  now: number,
  report: (p: SyncProgress) => void,
  failed: Set<string>,
) {
  const ratios = new Array(jobs.length).fill(0)
  let count = 0
  let scanned = 0
  let jobsDone = 0
  const emit = () =>
    report({
      phase,
      ratio: ratios.reduce((a, b) => a + b, 0) / Math.max(jobs.length, 1),
      count,
      failed: [...failed],
      scanned,
      jobsDone,
      jobs: jobs.length,
    })
  let next = 0
  const worker = async () => {
    while (next < jobs.length) {
      const i = next++
      try {
        await runJob(
          pool,
          jobs[i],
          now,
          (r) => {
            ratios[i] = r
            emit()
          },
          (added, seen) => {
            count += added
            scanned += seen
            emit()
          },
        )
        jobsDone++
        emit()
      } catch (err) {
        // 容量不足はリレーを変えても解決しないので、取得全体を止めて知らせる
        if (/quota/i.test(`${(err as Error).name} ${(err as Error).message}`)) {
          throw new Error('ブラウザの保存容量が足りません。空き容量を増やすか、設定でTLの取得日数を減らしてください。')
        }
        failed.add(jobs[i].relay)
        ratios[i] = 1
        jobsDone++
        emit()
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker))
  emit()
}

function chunks<T>(list: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size))
  return out
}

async function saveProfiles(events: Event[]) {
  const updatedAt = Date.now()
  const rows = [...newest(events).values()]
    .filter(verifyEvent)
    .map((e) => ({ pubkey: e.pubkey, name: displayName(e) ?? '', updatedAt }))
    .filter((p) => p.name)
  await db.profiles.bulkPut(rows)
}

export async function runSync(cfg: SyncConfig, report: (p: SyncProgress) => void) {
  const pool = new RelayPool()
  const failed = new Set<string>()
  const now = Math.floor(Date.now() / 1000)
  const me = cfg.pubkey
  const base = normalizeRelays(cfg.relays)

  try {
    report({ phase: 'discovery', ratio: 0, count: 0, failed: [] })
    const meta = (await pool.queryAny(base, { authors: [me], kinds: [0, 3, 10002] })).filter(verifyEvent)
    const relayEvent = newest(meta.filter((e) => e.kind === 10002)).get(me)
    const followEvent = newest(meta.filter((e) => e.kind === 3)).get(me)
    const mine = relayEvent ? parseRelayList(relayEvent) : { read: [], write: [] }
    const follows = followEvent ? parseFollows(followEvent).filter((p) => p !== me) : []
    await setKv('follows', follows)
    // 共有するときの投稿先に使う
    await setKv('writeRelays', mine.write)
    await saveProfiles(meta.filter((e) => e.kind === 0))

    const writeRelays = new Map<string, string[]>()
    const followList = chunks(follows, AUTHORS_PER_FILTER)
    for (const [i, authors] of followList.entries()) {
      const [lists, profiles] = await Promise.all([
        pool.queryAny(base, { authors, kinds: [10002] }),
        pool.queryAny(base, { authors, kinds: [0] }),
      ])
      for (const [pubkey, e] of newest(lists)) writeRelays.set(pubkey, parseRelayList(e).write)
      await saveProfiles(profiles)
      report({ phase: 'discovery', ratio: (i + 1) / followList.length, count: follows.length, failed: [] })
    }

    const ownRelays = normalizeRelays([...mine.write, ...base])
    await runPhase(
      pool,
      'me',
      ownRelays.map((relay) => ({
        key: `me:${relay}`,
        relay,
        filter: { authors: [me], kinds: [1, 5] },
        lower: NOSTR_EPOCH,
        save: (events) =>
          saveEvents(events, { store: 'posts', source: 'me', accept: (e) => e.pubkey === me }),
        oldestKnown: async () =>
          (await db.posts.where('[source+created_at]').between(['me', 0], ['me', Infinity]).first())?.created_at,
      })),
      PHASE_CONCURRENCY,
      now,
      report,
      failed,
    )

    const inboxRelays = normalizeRelays([...mine.read, ...base])
    await runPhase(
      pool,
      'incoming',
      inboxRelays.map((relay) => ({
        key: `incoming:${relay}`,
        relay,
        filter: { '#p': [me], kinds: [1, 6, 7, 9735] },
        lower: NOSTR_EPOCH,
        save: (events) =>
          saveEvents(events, {
            store: 'incoming',
            accept: (e) => e.pubkey !== me && e.tags.some((t) => t[0] === 'p' && t[1] === me),
          }),
        oldestKnown: async () => (await db.incoming.orderBy('created_at').first())?.created_at,
      })),
      PHASE_CONCURRENCY,
      now,
      report,
      failed,
    )

    const followSet = new Set(follows)
    const lower = now - cfg.tlDays * 86400
    const tlJobs = planRelays(follows, writeRelays, base).flatMap(({ relay, authors }) =>
      chunks([...authors].sort(), AUTHORS_PER_FILTER).map((part) => ({
        key: `tl:${relay}:${hash(part.join(''))}`,
        relay,
        filter: { authors: part, kinds: [1, 5] },
        lower,
        save: (events: Event[]) =>
          saveEvents(events, { store: 'posts', source: 'tl' as Post['source'], accept: (e) => followSet.has(e.pubkey) }),
      })),
    )
    await runPhase(pool, 'tl', tlJobs, 3, now, report, failed)
    await setKv('syncedAt', now)
    return { failed: [...failed] }
  } finally {
    pool.close()
  }
}
