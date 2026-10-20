type BackgroundWorkerResponse = { id: number; file?: File; error?: string }

let worker: Worker | null = null
let nextRequestId = 0
const pending = new Map<number, { resolve: (file: File) => void; reject: (error: Error) => void }>()

function getWorker() {
  if (worker) return worker
  worker = new Worker(new URL('./removeImageBackground.worker.ts', import.meta.url), { type: 'module' })
  worker.addEventListener('message', (event: MessageEvent<BackgroundWorkerResponse>) => {
    const request = pending.get(event.data.id)
    if (!request) return
    pending.delete(event.data.id)
    if (event.data.file) request.resolve(event.data.file)
    else request.reject(new Error(event.data.error || 'Das Bild konnte nicht freigestellt werden.'))
  })
  worker.addEventListener('error', () => {
    for (const request of pending.values()) request.reject(new Error('Die Hintergrundfreistellung ist fehlgeschlagen. Bitte versuche es erneut.'))
    pending.clear()
    worker?.terminate()
    worker = null
  })
  return worker
}

export function removeImageBackground(file: File) {
  const id = ++nextRequestId
  return new Promise<File>((resolve, reject) => {
    pending.set(id, { resolve, reject })
    try {
      getWorker().postMessage({ id, file })
    } catch (error) {
      pending.delete(id)
      reject(error instanceof Error ? error : new Error('Das Bild konnte nicht zur Verarbeitung übergeben werden.'))
    }
  })
}
