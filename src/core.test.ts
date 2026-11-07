import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { finalizeEvent, generateSecretKey, getPublicKey, verifyEvent, type Event, type EventTemplate } from 'nostr-tools/pure'
import { nip19 } from 'nostr-tools'
import { db, type Post } from './db'
import { parseAccount, saveEvents } from './nostr/events'
import { identify, proveOwnership } from './nostr/identity'
import { normalizeRelays, planRelays } from './nostr/relays'
import { nextAfterIdle } from './nostr/sync'
import { sha256Hex, shareEvent, uploadImage } from './nostr/share'
import {
  ALL_PRESETS,
  calendarData,
  greetingData,
  householdData,
  reportCard,
  stampData,
  trendWords,
} from './analysis/morePresets'
import { runPresetJob } from './analysis/presetJobs'
import { walkRange, type FetchPage } from './nostr/walk'
import { computeStats, computePower, wordRanking } from './analysis/stats'
import { stratifiedSample } from './analysis/sampling'
import { PostIndex, clip } from './analysis/prompt'
import { hitRate, kanjiNumber, splitCitations, tate, toBody } from './analysis/result'

const sk = generateSecretKey()
const me = getPublicKey(sk)
const sign = (kind: number, content: string, created_at: number, tags: string[][] = []) =>
  finalizeEvent({ kind, content, created_at, tags }, sk)

const post = (over: Partial<Post>): Post => ({
  id: Math.random().toString(36),
  pubkey: me,
  created_at: 1_700_000_000,
  content: '',
  source: 'me',
  mentions: [],
  ...over,
})

function fakeRelay(all: Event[], cap: number): FetchPage {
  return async (f) =>
    all
      .filter((e) => e.created_at >= f.since! && e.created_at <= f.until!)
      .sort((a, b) => b.created_at - a.created_at)
      .slice(0, cap)
}

describe('parseAccount', () => {
  it('npub と hex を受け付ける', () => {
    expect(parseAccount(nip19.npubEncode(me))).toBe(me)
    expect(parseAccount(me)).toBe(me)
  })
  it('nsec は拒否する', () => {
    expect(() => parseAccount(nip19.nsecEncode(sk))).toThrow('秘密鍵')
  })
  it('壊れた入力は日本語のエラーにする', () => {
    expect(() => parseAccount('hello')).toThrow('npub')
  })
})

describe('walkRange', () => {
  it('上限の小さいリレーでも全件読み切る', async () => {
    const all = Array.from({ length: 95 }, (_, i) => sign(1, `p${i}`, 1000 + i))
    const got = new Set<string>()
    await walkRange(fakeRelay(all, 10), { kinds: [1] }, 2000, 0, async (ev) => ev.forEach((e) => got.add(e.id)))
    expect(got.size).toBe(95)
  })
  it('同じ秒に投稿が集中しても止まらず読み切る', async () => {
    const all = [...Array.from({ length: 8 }, (_, i) => sign(1, `s${i}`, 1500)), sign(1, 'old', 1000)]
    const got = new Set<string>()
    await walkRange(fakeRelay(all, 5), { kinds: [1] }, 2000, 0, async (ev) => ev.forEach((e) => got.add(e.id)))
    expect(got.has(all[8].id)).toBe(true)
  })
})

describe('walkRange の終了条件', () => {
  it('until を無視して同じページを返すリレーでも終わる', async () => {
    const all = Array.from({ length: 5 }, (_, i) => sign(1, `p${i}`, 1000 + i))
    let pages = 0
    await walkRange(
      async () => {
        if (++pages > 20) throw new Error('終わらない')
        return all
      },
      { kinds: [1] },
      2000,
      0,
      async () => {},
    )
    expect(pages).toBeLessThanOrEqual(3)
  })
  it('onPage の指定した時刻まで飛ばす', async () => {
    const all = Array.from({ length: 100 }, (_, i) => sign(1, `p${i}`, 1000 + i))
    const got: number[] = []
    let jumped = false
    await walkRange(fakeRelay(all, 10), { kinds: [1] }, 2000, 0, async (events) => {
      got.push(...events.map((e) => e.created_at))
      if (jumped) return
      jumped = true
      return 1005
    })
    expect(got).toContain(1000)
    expect(got).not.toContain(1050)
  })
})

describe('重複だけのページが続いたとき', () => {
  it('続いたら取得済みの一番古い時刻へ飛ぶ', () => {
    expect(nextAfterIdle(6, 5000, 1000)).toBe(1000)
  })
  it('まだ続いていなければ飛ばない', () => {
    expect(nextAfterIdle(5, 5000, 1000)).toBeUndefined()
  })
  it('取得済みより古い範囲を読んでいるときは飛ばない', () => {
    expect(nextAfterIdle(6, 900, 1000)).toBeUndefined()
    expect(nextAfterIdle(6, 5000, undefined)).toBeUndefined()
  })
})

describe('planRelays', () => {
  it('多くの作者を覆うリレーを優先し、リストのない作者は既定へ回す', () => {
    const write = new Map([
      ['a', ['wss://x.example/', 'wss://y.example/']],
      ['b', ['wss://x.example/', 'wss://y.example/']],
      ['c', ['wss://z.example/']],
    ])
    const plan = planRelays(['a', 'b', 'c', 'd'], write, ['wss://base.example/'])
    expect(plan[0].authors).toEqual(['a', 'b'])
    expect(plan.find((p) => p.relay === 'wss://base.example/')?.authors).toEqual(['d'])
  })
  it('wss 以外は除外する', () => {
    expect(normalizeRelays(['ws://a.example', 'wss://b.example', 'nope'])).toEqual(['wss://b.example/'])
  })
})

describe('saveEvents', () => {
  beforeEach(async () => {
    await Promise.all([db.posts.clear(), db.tombstones.clear()])
  })
  const target = { store: 'posts' as const, source: 'me' as const, accept: (e: Event) => e.pubkey === me }

  it('署名の不正な投稿は保存しない', async () => {
    const good = sign(1, 'good', 1000)
    // 検証済みの印が残らないよう、リレーから届くのと同じJSON経由で作る
    const bad = { ...JSON.parse(JSON.stringify(sign(1, 'bad', 1000))), content: '改ざん' }
    expect(await saveEvents([good, bad], target)).toBe(1)
    expect(await db.posts.count()).toBe(1)
  })
  it('削除イベントは先でも後でも効く', async () => {
    const a = sign(1, 'a', 1000)
    const b = sign(1, 'b', 1000)
    await saveEvents([a], target)
    await saveEvents([sign(5, '', 1100, [['e', a.id]]), sign(5, '', 1100, [['e', b.id]])], target)
    await saveEvents([b], target)
    expect(await db.posts.count()).toBe(0)
  })
})

describe('proveOwnership', () => {
  const signer = (key: Uint8Array) => ({
    signEvent: async (template: Parameters<typeof finalizeEvent>[0]) => finalizeEvent(template, key),
  })

  it('本人の署名を受け入れる', async () => {
    expect(await proveOwnership(me, signer(sk))).toBe(true)
  })
  it('別の鍵の署名は拒否する', async () => {
    expect(await proveOwnership(me, signer(generateSecretKey()))).toBe(false)
  })
  it('使い回した署名は拒否する', async () => {
    const old = finalizeEvent({ kind: 22242, created_at: 1, tags: [['challenge', 'old']], content: '' }, sk)
    expect(await proveOwnership(me, { signEvent: async () => old })).toBe(false)
  })
  it('改ざんされた署名は拒否する', async () => {
    const forged = {
      signEvent: async (t: Parameters<typeof finalizeEvent>[0]) => ({
        ...JSON.parse(JSON.stringify(finalizeEvent({ ...t, content: '別の内容' }, sk))),
        content: t.content,
      }),
    }
    expect(await proveOwnership(me, forged)).toBe(false)
  })
})

describe('identify', () => {
  const signerFor = (key: Uint8Array) => ({
    getPublicKey: async () => getPublicKey(key),
    signEvent: async (template: Parameters<typeof finalizeEvent>[0]) => finalizeEvent(template, key),
  })

  it('初回ログインでは署名した鍵を持ち主として返す', async () => {
    expect(await identify(signerFor(sk))).toBe(me)
  })
  it('登録済みのアカウントと違う鍵は受け付けない', async () => {
    expect(await identify(signerFor(generateSecretKey()), me)).toBeNull()
  })
  it('公開鍵だけ偽っても、署名できなければ受け付けない', async () => {
    const liar = { ...signerFor(generateSecretKey()), getPublicKey: async () => me }
    expect(await identify(liar, me)).toBeNull()
  })
})

describe('統計', () => {
  it('空でも落ちない', () => {
    expect(computePower(computeStats([], [])).stats).toHaveLength(6)
  })
  it('返信率と反応数を数える', () => {
    const a = post({ id: 'a' })
    const b = post({ id: 'b', replyTo: 'x' })
    const s = computeStats([a, b], [{ id: 'r', kind: 7, pubkey: 'p', created_at: 1, target: 'a' }])
    expect(s.replyRate).toBe(0.5)
    expect(s.reactionsPerPost).toBe(0.5)
  })
  it('毎年上位の言葉は殿堂入りにし、残りを回数の多い順に並べる', () => {
    const y2023 = Date.UTC(2023, 5, 1) / 1000
    const y2024 = Date.UTC(2024, 5, 1) / 1000
    const posts = [
      ...Array.from({ length: 5 }, () => post({ content: 'ラーメン カレー https://a.example/ソバ', created_at: y2023 })),
      ...Array.from({ length: 3 }, () => post({ content: 'ラーメン パスタ', created_at: y2023 })),
      ...Array.from({ length: 5 }, () => post({ content: 'ラーメン ﾍﾟ', created_at: y2024 })),
    ]
    const { years, hall } = wordRanking(posts)
    expect(hall).toEqual([{ word: 'ラーメン', count: 13 }])
    expect(years.map((y) => y.year)).toEqual(['2023', '2024'])
    expect(years[0].words).toEqual([
      { word: 'カレー', count: 5 },
      { word: 'パスタ', count: 3 },
    ])
    expect(years[1].words).toEqual([{ word: 'ﾍﾟ', count: 5 }])
  })
  it('1年分しかなければ殿堂入りを作らない', () => {
    const created_at = Date.UTC(2023, 5, 1) / 1000
    const { years, hall } = wordRanking(Array.from({ length: 3 }, () => post({ content: 'ラーメン', created_at })))
    expect(hall).toEqual([])
    expect(years[0].words[0].word).toBe('ラーメン')
  })
})

describe('ワーカーで動かす処理', () => {
  beforeEach(async () => {
    await db.posts.clear()
    await db.posts.bulkPut([
      post({ id: 'a', source: 'me', created_at: 1_750_000_000, content: 'ラーメンを食べた話をしている' }),
      post({ id: 'b', source: 'me', created_at: 1_760_000_000, content: 'ダーツをした話をしている' }),
    ])
  })

  it('全プリセットの結果をワーカーから受け渡せる', async () => {
    for (const { id, free } of ALL_PRESETS) {
      const out = await runPresetJob({ type: free ? 'free' : 'prepare', id })
      expect(() => structuredClone(out)).not.toThrow()
    }
  })
  it('自由質問の準備もできる', async () => {
    const plan = { mode: 'overview', from: null, to: null, scope: 'me', keywords: [] } as const
    const out = await runPresetJob({ type: 'question', question: '趣味は?', plan: { ...plan, keywords: [] } })
    expect(out).toMatchObject({ postCount: 2 })
  })
  it('知らないプリセットはエラーにする', async () => {
    await expect(runPresetJob({ type: 'free', id: 'none' })).rejects.toThrow('見つかりません')
  })
})

describe('追加のプリセット', () => {
  const at = Date.UTC(2026, 5, 15, 3) / 1000

  it('全プリセットのIDが重複せず、無料は run か既存の集計を持つ', () => {
    const ids = ALL_PRESETS.map((p) => p.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids).toHaveLength(24)
    for (const p of ALL_PRESETS) expect(!!p.free || !!p.prepare).toBe(true)
  })
  it('通知表の評価は1から5に収まる', () => {
    const best = reportCard({ ...computeStats([], []), activeDays: 10, spanDays: 10, perDay: 200, replyRate: 1, avgLength: 200, reactionsPerPost: 9 })
    expect(best.items.every((i) => i.score === 5)).toBe(true)
    const worst = reportCard({ ...computeStats([], []), nightRate: 1 })
    expect(worst.items.every((i) => i.score === 1)).toBe(true)
    expect(worst.comment).toContain('もう少しがんばりましょう')
  })
  it('カレンダーは日ごとに数えて最多の日を出す', () => {
    const posts = [post({ created_at: at }), post({ created_at: at + 60 }), post({ created_at: at + 86400 })]
    const data = calendarData(posts)
    expect(data.total).toBe(3)
    expect(data.days).toBe(2)
    expect(data.best?.count).toBe(2)
  })
  it('家計簿は投稿を支出、反応を収入にする', () => {
    const data = householdData(
      [post({ created_at: at })],
      [
        { id: 'r', kind: 7, pubkey: 'p', created_at: at },
        { id: 'z', kind: 9735, pubkey: 'p', created_at: at },
      ],
      new Date(2026, 5, 20),
    )
    expect(data.rows).toHaveLength(12)
    expect(data.expense).toBe(1)
    expect(data.income).toBe(11)
    expect(data.balance).toBe(10)
  })
  it('年賀状は最後の投稿の年を集計する', () => {
    const data = greetingData([post({ created_at: at, content: 'ラーメン ラーメン カレー' })], [])
    expect(data).toMatchObject({ year: 2026, nextYear: 2027, total: 1, topWord: 'ラーメン' })
  })
  it('切手は最初の投稿と経過日数を出し、空でも落ちない', () => {
    expect(stampData([post({ created_at: at, content: 'はじめまして' })], at + 86400)).toMatchObject({
      firstText: 'はじめまして',
      days: 2,
      total: 1,
    })
    expect(stampData([], at).total).toBe(0)
  })
  it('流行語くらべは自分だけ、TLだけの言葉を分け、人の名前を除く', () => {
    const mine = new Map([['ダーツ', 5], ['ラーメン', 3]])
    const tl = new Map([['ラーメン', 50], ['選挙', 40], ['たろう', 90]])
    const data = trendWords(mine, tl, ['たろう'])
    expect(data.tlTop.map((w) => w.word)).toEqual(['ラーメン', '選挙'])
    expect(data.ignored.map((w) => w.word)).toEqual(['選挙'])
    expect(data.onlyMine.map((w) => w.word)).toEqual(['ダーツ'])
  })
})

describe('抽出と引用', () => {
  it('投稿の多い時期に偏らない', () => {
    const old = Array.from({ length: 50 }, () => post({ created_at: Date.UTC(2022, 1, 1) / 1000 }))
    const recent = Array.from({ length: 5000 }, () => post({ created_at: Date.UTC(2026, 1, 1) / 1000 }))
    const picked = stratifiedSample([...old, ...recent], 100)
    expect(picked).toHaveLength(100)
    expect(picked.filter((p) => old.includes(p)).length).toBe(50)
  })
  it('他の人の投稿は名前と宛先を消して渡す', () => {
    const index = new PostIndex()
    const other = post({
      source: 'tl',
      pubkey: 'f'.repeat(64),
      content: 'nostr:npub1abcdef こんにちは nostr:note1xyz',
    })
    const line = index.line(other)
    expect(line).toContain('TLの誰か: こんにちは')
    expect(line).not.toContain('npub1')
    expect(line).not.toContain('note1')
    expect(line).not.toContain('f'.repeat(8))
  })
  it('本文の平文の npub も消す', () => {
    expect(new PostIndex().line(post({ source: 'tl', content: 'npub1abc123 さん' }))).toContain('TLの誰か: さん')
  })
  it('本文に書かれた他の人の名前を伏せる', () => {
    const index = new PostIndex(['たろうさん', 'たろう', 'A.B*C', 'ねこ'])
    expect(index.line(post({ source: 'tl', content: 'たろうさんとA.B*Cが来た' }))).toContain('誰かと誰かが来た')
    expect(index.line(post({ content: '今日はたろうに会った' }))).toContain('私: 今日は誰かに会った')
  })
  it('短い名前は普通の言葉と重なるので伏せない', () => {
    expect(new PostIndex(['ねこ']).line(post({ content: 'ねこがいた' }))).toContain('ねこがいた')
  })
  it('同じ投稿には同じ番号を振る', () => {
    const index = new PostIndex()
    const p = post({ content: 'こんにちは' })
    expect(index.line(p)).toBe(index.line(p))
    expect(index.count).toBe(1)
    expect(index.citations.P1).toBe(p.id)
  })
  it('長い投稿は切り詰める', () => {
    expect(clip('あ'.repeat(500)).length).toBe(281)
  })
  it('存在しない番号はリンクにしない', () => {
    const parts = splitCitations('根拠[P1]と[P9]', { P1: 'id1' })
    expect(parts.filter((p) => p.type === 'cite')).toHaveLength(1)
    expect(parts.at(-1)).toEqual({ type: 'text', text: 'と[P9]' })
  })
  it('縦書き用に数字を漢数字、英字を全角にし、根拠番号を消す', () => {
    expect(tate('Nostrで120件[P3]')).toBe('Ｎｏｓｔｒで百二十件')
  })
  it.each([
    ['0', '〇'],
    ['7', '七'],
    ['10', '十'],
    ['11', '十一'],
    ['20', '二十'],
    ['101', '百一'],
    ['120', '百二十'],
    ['1000', '千'],
    ['1500', '千五百'],
    ['10000', '一万'],
    ['12000', '一万二千'],
    ['100000000', '一億'],
    ['007', '〇〇七'],
  ])('%s を漢数字にする', (digits, kanji) => {
    expect(kanjiNumber(digits)).toBe(kanji)
  })
  it.each([
    ['2026年11月1日', '二〇二六年十一月一日'],
    ['23:41に投稿', '二十三時四十一分に投稿'],
    ['23:00', '二十三時'],
    ['1,200件', '千二百件'],
    ['12.5%', '十二・五％'],
    ['１２０回', '百二十回'],
    ['3km', '三ｋｍ'],
  ])('%s を縦書き用にする', (text, expected) => {
    expect(tate(text)).toBe(expected)
  })
  it('構造化出力を種類ごとの本文にする', () => {
    expect(toBody('こんにちは')).toEqual({ type: 'text', text: 'こんにちは' })
    expect(toBody('{"items":[]}', 'appraisal')).toEqual({ type: 'appraisal', items: [] })
    expect(toBody('{"headline":"号外"}', 'newspaper', { issueNo: 3, daily: [] })).toMatchObject({ type: 'newspaper', issueNo: 3 })
    expect(toBody('{"title":"賢者"}', 'award')).toEqual({ type: 'award', award: { title: '賢者' } })
    expect(toBody('{"score":40}', 'drift')).toEqual({ type: 'drift', drift: { score: 40 } })
    expect(toBody('{"title":"対談"}', 'dialogue')).toEqual({ type: 'dialogue', dialogue: { title: '対談' } })
  })
  it('的中率を数える', () => {
    const item = { label: '', value: '', reason: '', confidence: '高' as const, evidence: [] }
    expect(hitRate([{ ...item, check: 'hit' }, { ...item, check: 'miss' }, item])).toEqual({ hits: 1, checked: 2 })
  })
})

describe('Nostrへの共有', () => {
  const sk = generateSecretKey()
  const signer = { signEvent: async (t: EventTemplate) => finalizeEvent(t, sk) }

  it('Blossomの認証を付けて画像をアップロードする', async () => {
    const blob = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' })
    const calls: { url: string; init: RequestInit }[] = []
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      calls.push({ url, init })
      return Response.json({ url: 'https://img.example/abc.png', sha256: 'abc', type: 'image/png' })
    })
    try {
      const out = await uploadImage('https://img.example', blob, { width: 10, height: 20 }, signer)
      expect(calls[0].url).toBe('https://img.example/upload')
      expect(calls[0].init.method).toBe('PUT')
      const headers = calls[0].init.headers as Record<string, string>
      const bytes = Uint8Array.from(atob(headers.authorization.replace('Nostr ', '')), (c) => c.charCodeAt(0))
      const auth = JSON.parse(new TextDecoder().decode(bytes))
      expect(auth.kind).toBe(24242)
      expect(auth.tags).toContainEqual(['t', 'upload'])
      expect(auth.tags).toContainEqual(['x', await sha256Hex(blob)])
      expect(verifyEvent(auth)).toBe(true)
      expect(out).toMatchObject({ url: 'https://img.example/abc.png', width: 10, height: 20 })
    } finally {
      vi.unstubAllGlobals()
    }
  })
  it('アップロードの失敗理由を伝える', async () => {
    vi.stubGlobal('fetch', async () => new Response('', { status: 413, headers: { 'x-reason': 'too large' } }))
    try {
      const blob = new Blob(['x'], { type: 'image/png' })
      await expect(uploadImage('https://img.example', blob, { width: 1, height: 1 }, signer)).rejects.toThrow('too large')
    } finally {
      vi.unstubAllGlobals()
    }
  })
  it('本文のハッシュタグと画像の情報をタグにする', () => {
    const image = { url: 'https://img.example/abc.png', sha256: 'abc', type: 'image/png', width: 10, height: 20 }
    const event = shareEvent('鑑定書\n\n#じぶん分析 #Nostr\nhttps://petansayu.github.io/nosce/', image)
    expect(event.kind).toBe(1)
    expect(event.content.endsWith('\nhttps://img.example/abc.png')).toBe(true)
    expect(event.tags).toContainEqual(['t', 'じぶん分析'])
    expect(event.tags).toContainEqual(['t', 'nostr'])
    expect(event.tags).toContainEqual(['imeta', 'url https://img.example/abc.png', 'm image/png', 'x abc', 'dim 10x20'])
  })
})
