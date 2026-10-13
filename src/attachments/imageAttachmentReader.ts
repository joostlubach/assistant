import { AssistantAttachmentReader } from './AssistantAttachmentReader'

/**
 * Reads images, which need no reading: they are their own preview. Used when the host has no readers of its own.
 */
export function imageAttachmentReader(accept: Record<string, string[]> = attachmentAccept): AssistantAttachmentReader<'image'> {
  return {
    kind: 'image',
    accept,
    read: async file => ({data: null, preview: file}),
  }
}

export const attachmentAccept: Record<string, string[]> = {
  'image/png':  ['.png'],
  'image/jpeg': ['.jpg', '.jpeg'],
}
