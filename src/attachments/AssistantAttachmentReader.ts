/**
 * Reads files of a kind that the user attaches, like images, into what the app needs to send them, and a preview.
 * Reading starts as soon as a file is attached, so that problems show before sending.
 */
export interface AssistantAttachmentReader<K extends AssistantAttachmentKind = AssistantAttachmentKind> {
  readonly kind: K

  /** The files it reads, by MIME type with their extensions, like for a file input. */
  readonly accept: Record<string, string[]>

  /** Whether it reads a file. By default, whether its MIME type or extension is in `accept`. */
  matches?(file: File): boolean

  read(file: File): Promise<AssistantAttachmentContent<K>>
}

/**
 * The data of attachments, by kind. Apps add their own kinds by augmenting this interface:
 *
 * ```ts
 * declare module 'assistant' {
 *   interface AssistantAttachmentKinds {
 *     design: DesignReference
 *   }
 * }
 * ```
 */
export interface AssistantAttachmentKinds {
  image: null
}

export type AssistantAttachmentKind = keyof AssistantAttachmentKinds

export interface AssistantAttachmentContent<K extends AssistantAttachmentKind = AssistantAttachmentKind> {
  data: AssistantAttachmentKinds[K]

  /** An image to show the attachment by, before and after sending. */
  preview: Blob
}

export type AnyAssistantAttachmentReader = {
  [K in AssistantAttachmentKind]: AssistantAttachmentReader<K>
}[AssistantAttachmentKind]
