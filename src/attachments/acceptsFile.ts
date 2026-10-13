/**
 * Whether a file is accepted, by its MIME type (also like `image/*`), or by its extension.
 */
export function acceptsFile(accept: Record<string, string[]>, file: File) {
  const extension = file.name.includes('.') ? `.${file.name.split('.').pop()!.toLowerCase()}` : null

  for (const [type, extensions] of Object.entries(accept)) {
    if (type === file.type) { return true }
    if (type.endsWith('/*') && file.type.startsWith(type.slice(0, -1))) { return true }
    if (extension != null && extensions.includes(extension)) { return true }
  }
  return false
}
