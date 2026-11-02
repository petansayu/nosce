import { useEffect, useRef, useState } from 'react'
import { toPng } from 'html-to-image'
import { db, getAccount, profileNames, type AppraisalItem, type SavedResult } from '../db'
import { Loading } from '../components/Loading'
import { Newspaper } from '../components/Newspaper'
import { AppraisalSheet, AwardSheet, DialogueSheet, DriftSheet, PowerSheet, WordsSheet } from '../components/Sheets'
import { ThemeSheet } from '../components/ThemeSheets'
import { formatCost } from '../analysis/llm'
import { hitRate, splitCitations } from '../analysis/result'
import type { Power, WordRanking, WordYear } from '../analysis/stats'
import type { Route } from '../App'

type Go = (r: Route) => void

function Cited({ text, citations, go }: { text: string; citations: Record<string, string>; go: Go }) {
  return (
    <>
      {splitCitations(text, citations).map((part, i) =>
        part.type === 'text' ? (
          <span key={i}>{part.text}</span>
        ) : (
          <button key={i} className="cite" onClick={() => go({ name: 'timeline', focus: citations[part.tag] })}>
            {part.tag}
          </button>
        ),
      )}
    </>
  )
}

function TextBody({ text, citations, go }: { text: string; citations: Record<string, string>; go: Go }) {
  return (
    <div className="rich">
      {text.split('\n').map((line, i) => {
        const heading = line.match(/^(#{1,4})\s+(.*)$/)
        if (heading) return <h3 key={i}>{heading[2].replace(/\*\*/g, '')}</h3>
        if (!line.trim()) return null
        return (
          <p key={i}>
            <Cited text={line.replace(/\*\*/g, '')} citations={citations} go={go} />
          </p>
        )
      })}
    </div>
  )
}

function CheckPanel({
  result,
  go,
  onCheck,
}: {
  result: SavedResult
  go: Go
  onCheck: (index: number, check: AppraisalItem['check']) => void
}) {
  if (result.body.type !== 'appraisal') return null
  const items = result.body.items
  const { hits, checked } = hitRate(items)
  return (
    <div className="evidence">
      <h3>答え合わせ</h3>
      {items.map((item, i) => (
        <div key={i} className="check-row">
          <span>{item.label}</span>
          <span>
            {item.evidence
              .filter((tag) => result.citations[tag])
              .map((tag) => (
                <button key={tag} className="cite" onClick={() => go({ name: 'timeline', focus: result.citations[tag] })}>
                  {tag}
                </button>
              ))}
          </span>
          <div className="checks">
            <button className={item.check === 'hit' ? 'on' : ''} onClick={() => onCheck(i, 'hit')}>
              正解
            </button>
            <button className={item.check === 'miss' ? 'on' : ''} onClick={() => onCheck(i, 'miss')}>
              外れ
            </button>
          </div>
        </div>
      ))}
      <p className="muted small">的中率 {checked ? `${hits}/${checked}` : '未チェック'}</p>
    </div>
  )
}

type EvidenceRow = { title: string; evidence: string[] }

// 紙面を本物らしく見せるため、根拠の番号は紙面の外に並べる
function evidenceRows(result: SavedResult): EvidenceRow[] {
  const { body } = result
  switch (body.type) {
    case 'newspaper':
      return [
        { title: body.paper.headline, evidence: body.paper.leadEvidence },
        ...body.paper.articles.slice(0, 3),
        body.paper.column,
      ]
    case 'sheet': {
      const { evidence } = body.data as { evidence?: string[] }
      return evidence?.length ? [{ title: '根拠にした投稿', evidence }] : []
    }
    case 'award':
      return [{ title: body.award.title, evidence: body.award.evidence }]
    case 'dialogue':
      return [{ title: '再現に使った投稿', evidence: body.dialogue.evidence }]
    case 'drift':
      return [
        { title: '主な症例', evidence: body.drift.flowedExamples.map((e) => e.evidence) },
        { title: '自律の兆候', evidence: body.drift.ownExamples.map((e) => e.evidence) },
      ]
    default:
      return []
  }
}

function EvidenceList({ rows, citations, go }: { rows: EvidenceRow[]; citations: Record<string, string>; go: Go }) {
  if (!rows.length) return null
  return (
    <div className="evidence">
      <h3>根拠の投稿</h3>
      {rows.map((row, i) => (
        <p key={i} className="small">
          <span className="muted">{row.title}</span>
          {row.evidence
            .filter((tag) => citations[tag])
            .map((tag) => (
              <button key={tag} className="cite" onClick={() => go({ name: 'timeline', focus: citations[tag] })}>
                {tag}
              </button>
            ))}
        </p>
      ))}
    </div>
  )
}

export function Result({ id, go }: { id: number; go: Go }) {
  const [result, setResult] = useState<SavedResult>()
  const [name, setName] = useState('あなた')
  const [error, setError] = useState('')
  const sheet = useRef<HTMLDivElement>(null)

  useEffect(() => {
    void db.results.get(id).then(setResult)
    void Promise.all([getAccount(), profileNames()]).then(([account, names]) => {
      const own = account && names.get(account)
      if (own) setName(own)
    })
  }, [id])

  if (!result) return <Loading />

  const onCheck = async (index: number, check: AppraisalItem['check']) => {
    if (result.body.type !== 'appraisal') return
    const items = result.body.items.map((item, i) =>
      i === index ? { ...item, check: item.check === check ? undefined : check } : item,
    )
    const next = { ...result, body: { type: 'appraisal' as const, items } }
    setResult(next)
    await db.results.put(next)
  }

  const saveImage = async () => {
    try {
      const page = sheet.current!.querySelector<HTMLElement>('[data-page]')
      const url = page
        ? await toPng(page, {
            width: page.offsetWidth,
            height: page.offsetHeight,
            style: { transform: 'none' },
            pixelRatio: 2,
          })
        : await toPng(sheet.current!, {
            backgroundColor: getComputedStyle(document.body).backgroundColor,
            pixelRatio: 2,
          })
      const a = document.createElement('a')
      a.href = url
      a.download = `${result.title.slice(0, 30)}.png`
      a.click()
    } catch {
      setError('画像を作れませんでした。')
    }
  }

  const { body, citations, createdAt } = result
  return (
    <section className="card">
      <div className="row spread">
        <button onClick={() => go({ name: 'history' })}>履歴へ</button>
        <button onClick={saveImage}>画像で保存</button>
      </div>
      {error && <p className="error">{error}</p>}
      <div ref={sheet} className="sheet">
        {body.type === 'text' && (
          <>
            <h1>{result.title}</h1>
            <TextBody text={body.text} citations={citations} go={go} />
          </>
        )}
        {body.type === 'newspaper' && (
          <Newspaper paper={body.paper} issueNo={body.issueNo} daily={body.daily} createdAt={createdAt} />
        )}
        {body.type === 'appraisal' && <AppraisalSheet items={body.items} name={name} createdAt={createdAt} />}
        {body.type === 'award' && <AwardSheet award={body.award} name={name} createdAt={createdAt} />}
        {body.type === 'drift' && <DriftSheet drift={body.drift} name={name} createdAt={createdAt} />}
        {body.type === 'dialogue' && <DialogueSheet dialogue={body.dialogue} name={name} />}
        {body.type === 'sheet' && (
          <ThemeSheet id={result.presetId} data={body.data} name={name} createdAt={createdAt} />
        )}
        {body.type === 'power' && <PowerSheet data={body.data as Power} name={name} />}
        {body.type === 'words' && <WordsSheet data={body.data as WordRanking | WordYear[]} name={name} />}
      </div>
      <CheckPanel result={result} go={go} onCheck={onCheck} />
      <EvidenceList rows={evidenceRows(result)} citations={citations} go={go} />
      {result.truncated && <p className="error">長くなったため、途中で切れています。</p>}
      <p className="muted small">
        分析に使った投稿 {result.postCount.toLocaleString()}件
        {result.costUsd > 0 && ` ・ 費用 ${formatCost(result.costUsd)}`}
        {!result.costUsd &&
          result.tokens &&
          ` ・ 入力 ${result.tokens.input.toLocaleString()} / 出力 ${result.tokens.output.toLocaleString()}トークン`}
      </p>
    </section>
  )
}
