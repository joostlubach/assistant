import Logger from 'logger'
import { action, computed, makeObservable, observable } from 'mobx'
import { bindMethods, errorMessage } from 'ytil'
import { acceptsFile } from './acceptsFile'
import {
  AnyAssistantAttachmentReader,
  AssistantAttachmentContent,
  AssistantAttachmentKind,
  AssistantAttachmentKinds,
} from './AssistantAttachmentReader'

/**
 * The files the user is about to send along with their message. Each is read by the first reader that matches it, as
 * soon as it is attached; files that no reader matches are left out.
 */
export class AttachmentsContainer {

  constructor(
    private readonly readers: AnyAssistantAttachmentReader[],
  ) {
    makeObservable(this)
    bindMethods(this)
  }

  private readonly logger = new Logger('AttachmentsContainer')

  // By reference, so that a read replaces the attachment it was started for.
  @observable.ref
  private accessor _attachments: AssistantAttachment[] = []

  public all() {
    return [...this._attachments]
  }

  @computed
  public get count() { return this._attachments.length }

  /** Whether all attachments have been read, so that they can be sent. */
  @computed
  public get ready() {
    return this._attachments.every(it => it.status === 'ready')
  }

  /** The files that can be attached, like for a file input. */
  public get accept() {
    const accept: Record<string, string[]> = {}
    for (const reader of this.readers) {
      for (const [type, extensions] of Object.entries(reader.accept)) {
        accept[type] = [...accept[type] ?? [], ...extensions]
      }
    }
    return accept
  }

  @action
  public attach(files: File[]) {
    for (const file of files) {
      const reader = this.readers.find(it => it.matches?.(file) ?? acceptsFile(it.accept, file))
      if (reader == null) { continue }

      const attachment = {kind: reader.kind, file, status: 'reading', data: null, preview: null, error: null} as AssistantAttachment
      this._attachments = [...this._attachments, attachment]
      void this.read(attachment, reader)
    }
  }

  @action
  public detach(attachment: AssistantAttachment) {
    revoke(attachment)
    this._attachments = this._attachments.filter(it => it !== attachment)
  }

  /** Removes all attachments, to send them. The sent message shows thumbnails of its own. */
  @action
  public take(): AssistantAttachment[] {
    const taken = this._attachments
    taken.forEach(revoke)
    this._attachments = []
    return taken
  }

  public dispose() {
    this._attachments.forEach(revoke)
  }

  private async read(attachment: AssistantAttachment, reader: AnyAssistantAttachmentReader) {
    try {
      const {data, preview}: AssistantAttachmentContent = await reader.read(attachment.file)
      this.replace(attachment, {...attachment, status: 'ready', data, preview, url: URL.createObjectURL(preview)} as AssistantAttachment)
    } catch (error) {
      this.logger.error(`Could not read ${attachment.file.name}`, error)
      this.replace(attachment, {...attachment, status: 'failed', error: errorMessage(error)})
    }
  }

  @action
  private replace(attachment: AssistantAttachment, replacement: AssistantAttachment) {
    // It may have been detached in the meantime.
    if (!this._attachments.includes(attachment)) {
      revoke(replacement)
      return
    }
    this._attachments = this._attachments.map(it => it === attachment ? replacement : it)
  }

}

export type AssistantAttachment = {
  [K in AssistantAttachmentKind]: AssistantAttachmentOf<K>
}[AssistantAttachmentKind]

export interface AssistantAttachmentOf<K extends AssistantAttachmentKind> {
  kind:   K
  file:   File
  status: AssistantAttachmentStatus

  /** Once read. */
  data:    AssistantAttachmentKinds[K] | null
  preview: Blob | null
  url?:    string

  /** Why it could not be read. */
  error: string | null
}

/** An attachment that the host uploaded, with how the app refers to it as an image, or `null` if it is kept in memory. */
export type AssistantUploadedAttachment = AssistantAttachment & {image: string | null}

export type AssistantAttachmentStatus = 'reading' | 'ready' | 'failed'

function revoke(attachment: AssistantAttachment) {
  if (attachment.url != null) {
    URL.revokeObjectURL(attachment.url)
  }
}
