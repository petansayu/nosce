import { runPresetJob, type PresetJob } from './presetJobs'

self.onmessage = async (ev: MessageEvent<PresetJob>) => {
  try {
    self.postMessage({ result: await runPresetJob(ev.data) })
  } catch (err) {
    self.postMessage({ error: err instanceof Error ? err.message : String(err) })
  }
}
