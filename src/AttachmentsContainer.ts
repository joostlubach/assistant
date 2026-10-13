import { action, computed, makeObservable, observable } from 'mobx'
import { bindMethods } from 'ytil'

/**
 * The images the user is about to send along with their message, for the LLM to see.
 */
export class AttachmentsContainer {

  constructor() {
    makeObservable(this)
    bindMethods(this)
  }

  @observable.ref
  private accessor _attachments: AssistantAttachment[] = []

  public all() {
    return [...this._attachments]
  }

  @computed
  public get count() { return this._attachments.length }

  /** Files of other types are left out. */
  @action
  public attach(files: File[]) {
    for (const file of files) {
      if (!(file.type in attachmentAccept)) { continue }
      this._attachments = [...this._attachments, {file, url: URL.createObjectURL(file)}]
    }
  }

  @action
  public detach(attachment: AssistantAttachment) {
    URL.revokeObjectURL(attachment.url)
    this._attachments = this._attachments.filter(it => it !== attachment)
  }

  @action
  public take(): AssistantAttachment[] {
    const taken = this._attachments
    for (const attachment of taken) {
      URL.revokeObjectURL(attachment.url)
    }
    this._attachments = []
    return taken
  }

  public dispose() {
    for (const attachment of this._attachments) {
      URL.revokeObjectURL(attachment.url)
    }
  }

}

export interface AssistantAttachment {
  file: File
  url:  string
}

export const attachmentAccept: Record<string, string[]> = {
  'image/png':  ['.png'],
  'image/jpeg': ['.jpg', '.jpeg'],
}
