/**
 * A small data URL of an image, to show in the conversation. Unlike an object URL, it can be stored with it.
 */
export async function thumbnailURL(image: Blob): Promise<string> {
  const bitmap = await createImageBitmap(image)
  const scale = Math.min(1, maxDimension / Math.max(bitmap.width, bitmap.height))
  const width = Math.round(bitmap.width * scale)
  const height = Math.round(bitmap.height * scale)

  const canvas = new OffscreenCanvas(width, height)
  const context = canvas.getContext('2d')
  if (context == null) {
    bitmap.close()
    throw new Error("Could not create a canvas context")
  }

  context.drawImage(bitmap, 0, 0, width, height)
  bitmap.close()

  // WebP keeps transparency.
  const blob = await canvas.convertToBlob({type: 'image/webp', quality: 0.8})
  return await new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(blob)
  })
}

const maxDimension = 480
