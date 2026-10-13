import type { LLMImageBlock } from '../llm/types'
import { base64 } from './base64'

/**
 * Converts an image to an image block for the LLM: scaled down, as a JPEG on a neutral background (so that transparent
 * parts are recognizable). This keeps the conversation, which is sent in full on every turn, small.
 */
export async function imageBlock(image: Blob): Promise<ImageBlockResult> {
  const bitmap = await createImageBitmap(image)
  const scale = Math.min(1, maxImageDimension / Math.max(bitmap.width, bitmap.height))
  const width = Math.round(bitmap.width * scale)
  const height = Math.round(bitmap.height * scale)

  const canvas = new OffscreenCanvas(width, height)
  const context = canvas.getContext('2d')
  if (context == null) {
    throw new Error("Could not create a canvas context")
  }

  context.fillStyle = background
  context.fillRect(0, 0, width, height)
  context.drawImage(bitmap, 0, 0, width, height)

  const original = {width: bitmap.width, height: bitmap.height}
  bitmap.close()

  const blob = await canvas.convertToBlob({type: 'image/jpeg', quality: 0.85})
  return {
    original,
    block: {
      type:       'image',
      media_type: 'image/jpeg',
      data:       base64(new Uint8Array(await blob.arrayBuffer())),
    },
  }
}

export interface ImageBlockResult {
  block:    LLMImageBlock
  original: {width: number, height: number}
}

export const maxImageDimension = 1280
const background = '#808080'
