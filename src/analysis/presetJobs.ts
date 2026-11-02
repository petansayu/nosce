import { ALL_PRESETS } from './morePresets'
import { prepareQuestion, runFreePreset, type Prepared, type QuestionPlan } from './presets'
import type { ResultBody } from '../db'

export type PresetJob =
  | { type: 'free'; id: string }
  | { type: 'prepare'; id: string }
  | { type: 'question'; question: string; plan: QuestionPlan }

export async function runPresetJob(job: PresetJob): Promise<Prepared | ResultBody> {
  if (job.type === 'question') return prepareQuestion(job.question, job.plan)
  const preset = ALL_PRESETS.find((p) => p.id === job.id)
  if (!preset) throw new Error(`プリセットが見つかりません: ${job.id}`)
  if (job.type === 'prepare') return preset.prepare!()
  return preset.run ? preset.run() : runFreePreset(preset.id)
}

// 全投稿の読み込みと集計で画面が固まらないよう、ワーカーで実行する
export function runInWorker<T extends Prepared | ResultBody>(job: PresetJob) {
  const worker = new Worker(new URL('./preset.worker.ts', import.meta.url), { type: 'module' })
  return new Promise<T>((resolve, reject) => {
    worker.onmessage = ({ data }) => (data.error === undefined ? resolve(data.result) : reject(new Error(data.error)))
    worker.onerror = (e) => reject(new Error(e.message || '読み込みに失敗しました。ページを開き直してください。'))
    worker.postMessage(job)
  }).finally(() => worker.terminate())
}
