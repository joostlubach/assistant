let nextID = 1

/** A unique ID for an attachment, to tell it apart in lists. */
export function attachmentID() {
  return nextID++
}
