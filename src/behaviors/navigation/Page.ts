/**
 * A page of the app that the assistant can take the user to.
 */
export interface Page {
  pattern:     string
  description: string
}

export function pageList(pages: Page[]) {
  return pages.map(it => `- \`${it.pattern}\`: ${it.description}`).join('\n')
}
