import { describe, expect, it } from 'vitest'
import { acceptsFile } from '../attachments/acceptsFile'
import { AssistantAttachmentReader } from '../attachments/AssistantAttachmentReader'
import { AttachmentsContainer } from '../attachments/AttachmentsContainer'
import { imageAttachmentReader } from '../attachments/imageAttachmentReader'
import { deferred } from './helpers'

declare module '../attachments/AssistantAttachmentReader' {
  interface AssistantAttachmentKinds {
    test_design: {layers: number}
  }
}

describe('AttachmentsContainer', () => {

  it('attaches PNG and JPEG images by default, and leaves out other files', async () => {
    const container = new AttachmentsContainer([imageAttachmentReader()])
    const png = file('logo.png', 'image/png')
    container.attach([png, file('notes.txt', 'text/plain')])
    await settled()

    expect(container.all()).toEqual([
      {id: expect.any(Number), kind: 'image', file: png, status: 'ready', data: null, preview: png, url: expect.any(String), error: null},
    ])
  })

  it('reads each file with the first reader that matches it', async () => {
    const {reader} = designReader()
    const container = new AttachmentsContainer([reader, imageAttachmentReader()])
    container.attach([file('design.psd', ''), file('photo.png', 'image/png')])
    await settled()

    expect(container.all().map(it => it.kind)).toEqual(['test_design', 'image'])
  })

  it('is not ready until all attachments have been read', async () => {
    const {reader, read} = designReader()
    const container = new AttachmentsContainer([reader])
    container.attach([file('design.psd', '')])

    expect(container.ready).toBe(false)
    expect(container.all()[0]).toMatchObject({status: 'reading', data: null, preview: null})

    read.resolve()
    await settled()

    expect(container.ready).toBe(true)
    expect(container.all()[0]).toMatchObject({status: 'ready', data: {layers: 3}, preview: expect.any(Blob)})
  })

  it('keeps a file that could not be read, with the reason, until it is detached', async () => {
    const reader: AssistantAttachmentReader<'test_design'> = {
      kind:   'test_design',
      accept: {'image/vnd.adobe.photoshop': ['.psd']},
      read:   async () => { throw new Error('Corrupt file') },
    }
    const container = new AttachmentsContainer([reader])
    container.attach([file('design.psd', '')])
    await settled()

    expect(container.ready).toBe(false)
    expect(container.all()[0]).toMatchObject({status: 'failed', error: 'Corrupt file'})

    container.detach(container.all()[0])
    expect(container.ready).toBe(true)
  })

  it('drops a read of a file that was detached in the meantime', async () => {
    const {reader, read} = designReader()
    const container = new AttachmentsContainer([reader])
    container.attach([file('design.psd', '')])

    container.detach(container.all()[0])
    read.resolve()
    await settled()

    expect(container.count).toBe(0)
  })

  it('shows an image file itself while it is being read', async () => {
    const read = deferred()
    const reader: AssistantAttachmentReader<'image'> = {
      kind:   'image',
      accept: {'image/png': ['.png']},
      read:   async file => {
        await read.promise
        return {data: null, preview: file}
      },
    }
    const container = new AttachmentsContainer([reader])
    container.attach([file('logo.png', 'image/png')])

    const {url} = container.all()[0]
    expect(url).toEqual(expect.any(String))

    read.resolve()
    await settled()

    expect(container.all()[0]).toMatchObject({status: 'ready', url})
  })

  it('has no preview of a file the browser cannot show until it has been read', () => {
    const {reader} = designReader()
    const container = new AttachmentsContainer([reader])
    container.attach([file('design.psd', 'image/vnd.adobe.photoshop')])

    expect(container.all()[0].url).toBeUndefined()
  })

  it('combines what its readers accept', () => {
    const {reader} = designReader()
    const container = new AttachmentsContainer([reader, imageAttachmentReader({'image/png': ['.png']})])
    expect(container.accept).toEqual({'image/vnd.adobe.photoshop': ['.psd'], 'image/png': ['.png']})
  })

})

describe('acceptsFile', () => {

  it('accepts files by MIME type, wildcard or extension', () => {
    const accept = {'image/*': [], 'application/pdf': ['.pdf'], 'application/octet-stream': ['.psd']}
    expect(acceptsFile(accept, file('a.webp', 'image/webp'))).toBe(true)
    expect(acceptsFile(accept, file('a', 'application/pdf'))).toBe(true)
    expect(acceptsFile(accept, file('A.PSD', ''))).toBe(true)
    expect(acceptsFile(accept, file('a.txt', 'text/plain'))).toBe(false)
  })

})

function designReader() {
  const read = deferred()
  const reader: AssistantAttachmentReader<'test_design'> = {
    kind:   'test_design',
    accept: {'image/vnd.adobe.photoshop': ['.psd']},
    read:   async () => {
      await read.promise
      return {data: {layers: 3}, preview: new Blob(['preview'], {type: 'image/png'})}
    },
  }
  return {reader, read}
}

function file(name: string, type: string) {
  return new File(['content'], name, {type})
}

async function settled() {
  for (let i = 0; i < 10; i++) {
    await Promise.resolve()
  }
}
