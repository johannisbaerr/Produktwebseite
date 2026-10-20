import type * as ort from 'onnxruntime-web/wasm'

const modelUrl = 'https://huggingface.co/Ko033/isnet-general-use-onnx/resolve/5349b617911fd60c619b52f32e2b593517b78df3/onnx/model_quantized.onnx'
const modelSize = 1024
const maxUploadSize = 5 * 1024 * 1024
const maxOutputSide = 2200

let runtimePromise: Promise<typeof import('onnxruntime-web/wasm')> | null = null
let sessionPromise: Promise<ort.InferenceSession> | null = null

function getRuntime() {
  if (!runtimePromise) runtimePromise = import('onnxruntime-web/wasm')
  return runtimePromise
}

async function getSession() {
  if (!sessionPromise) {
    sessionPromise = getRuntime().then((runtime) => runtime.InferenceSession.create(modelUrl, { executionProviders: ['wasm'] }))
      .catch(() => {
        sessionPromise = null
        throw new Error('Das lokale Freistellungsmodell konnte nicht geladen werden. Prüfe die Internetverbindung und versuche es erneut.')
      })
  }
  return sessionPromise
}

async function canvasBlob(canvas: OffscreenCanvas) {
  return canvas.convertToBlob({ type: 'image/webp', quality: 0.92 })
}

async function removeBackground(file: File) {
  let image: ImageBitmap
  try {
    image = await createImageBitmap(file)
  } catch {
    throw new Error(`„${file.name}“ konnte nicht als Bild geöffnet werden.`)
  }

  try {
    const inputCanvas = new OffscreenCanvas(modelSize, modelSize)
    const inputContext = inputCanvas.getContext('2d', { willReadFrequently: true })
    if (!inputContext) throw new Error('Die Bildverarbeitung wird von diesem Browser nicht unterstützt.')

    const inputScale = Math.min(modelSize / image.width, modelSize / image.height)
    const fittedWidth = Math.max(1, Math.round(image.width * inputScale))
    const fittedHeight = Math.max(1, Math.round(image.height * inputScale))
    const offsetX = Math.floor((modelSize - fittedWidth) / 2)
    const offsetY = Math.floor((modelSize - fittedHeight) / 2)
    inputContext.fillStyle = '#808080'
    inputContext.fillRect(0, 0, modelSize, modelSize)
    inputContext.drawImage(image, offsetX, offsetY, fittedWidth, fittedHeight)
    const pixels = inputContext.getImageData(0, 0, modelSize, modelSize).data
    const planeSize = modelSize * modelSize
    const input = new Float32Array(planeSize * 3)
    for (let pixel = 0; pixel < planeSize; pixel++) {
      const source = pixel * 4
      input[pixel] = pixels[source] / 255 - 0.5
      input[planeSize + pixel] = pixels[source + 1] / 255 - 0.5
      input[planeSize * 2 + pixel] = pixels[source + 2] / 255 - 0.5
    }

    const runtime = await getRuntime()
    const session = await getSession()
    const outputs = await session.run({
      [session.inputNames[0]]: new runtime.Tensor('float32', input, [1, 3, modelSize, modelSize]),
    })
    const output = outputs[session.outputNames[0]]
    if (!output || !(output.data instanceof Float32Array) || output.data.length !== planeSize) {
      throw new Error('Das KI-Modell hat ein unerwartetes Ergebnis geliefert.')
    }

    let minimum = Infinity
    let maximum = -Infinity
    for (let y = offsetY; y < offsetY + fittedHeight; y++) {
      for (let x = offsetX; x < offsetX + fittedWidth; x++) {
        const alpha = output.data[y * modelSize + x]
        minimum = Math.min(minimum, alpha)
        maximum = Math.max(maximum, alpha)
      }
    }
    if (!Number.isFinite(minimum) || maximum - minimum < 0.00001) {
      throw new Error('Der Bildhintergrund konnte nicht zuverlässig erkannt werden.')
    }

    const maskCanvas = new OffscreenCanvas(modelSize, modelSize)
    const maskContext = maskCanvas.getContext('2d')
    if (!maskContext) throw new Error('Die Bildverarbeitung wird von diesem Browser nicht unterstützt.')
    const maskPixels = maskContext.createImageData(modelSize, modelSize)
    for (let pixel = 0; pixel < planeSize; pixel++) {
      const target = pixel * 4
      maskPixels.data[target] = 255
      maskPixels.data[target + 1] = 255
      maskPixels.data[target + 2] = 255
      const probability = Math.max(0, Math.min(1, output.data[pixel]))
      const edgePosition = Math.max(0, Math.min(1, (probability - 0.16) / (0.84 - 0.16)))
      const softenedAlpha = edgePosition * edgePosition * (3 - 2 * edgePosition)
      maskPixels.data[target + 3] = Math.round(softenedAlpha * 255)
    }
    maskContext.putImageData(maskPixels, 0, 0)

    let scale = Math.min(1, maxOutputSide / Math.max(image.width, image.height))
    let blob: Blob
    while (true) {
      const width = Math.max(1, Math.round(image.width * scale))
      const height = Math.max(1, Math.round(image.height * scale))
      const outputCanvas = new OffscreenCanvas(width, height)
      const context = outputCanvas.getContext('2d')
      if (!context) throw new Error('Die Bildverarbeitung wird von diesem Browser nicht unterstützt.')
      context.imageSmoothingQuality = 'high'
      context.drawImage(image, 0, 0, width, height)
      context.globalCompositeOperation = 'destination-in'
      context.drawImage(maskCanvas, offsetX, offsetY, fittedWidth, fittedHeight, 0, 0, width, height)
      blob = await canvasBlob(outputCanvas)
      if (blob.size <= maxUploadSize) break
      if (scale <= 0.35) throw new Error(`Das freigestellte Bild „${file.name}“ ist trotz Komprimierung zu groß.`)
      scale *= 0.82
    }

    const outputType = blob.type === 'image/webp' ? 'image/webp' : 'image/png'
    const outputExtension = outputType === 'image/webp' ? 'webp' : 'png'
    const outputName = `${file.name.replace(/\.[^.]+$/, '') || 'produktbild'}.${outputExtension}`
    return new File([blob], outputName, { type: outputType, lastModified: file.lastModified })
  } finally {
    image.close()
  }
}

self.onmessage = async (event: MessageEvent<{ id: number; file: File }>) => {
  const { id, file } = event.data
  try {
    const processedFile = await removeBackground(file)
    self.postMessage({ id, file: processedFile })
  } catch (error) {
    self.postMessage({ id, error: error instanceof Error ? error.message : 'Das Bild konnte nicht freigestellt werden.' })
  }
}
