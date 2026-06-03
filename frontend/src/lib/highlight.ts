// In-content find/highlight: wrap matches of `term` in <mark data-qs> within a
// container, returning the match count. Used by the summary viewers' find box.

export function clearHighlights(container: HTMLElement): void {
  container.querySelectorAll('mark[data-qs]').forEach(m => {
    const parent = m.parentNode
    if (!parent) return
    parent.replaceChild(document.createTextNode(m.textContent || ''), m)
    parent.normalize()
  })
}

export function applyHighlights(container: HTMLElement, term: string): number {
  clearHighlights(container)
  const q = term.trim()
  if (!q) return 0
  const lower = q.toLowerCase()
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) =>
      node.nodeValue && node.nodeValue.toLowerCase().includes(lower)
        ? NodeFilter.FILTER_ACCEPT
        : NodeFilter.FILTER_REJECT,
  })
  const targets: Text[] = []
  let n: Node | null
  while ((n = walker.nextNode())) targets.push(n as Text)

  let count = 0
  for (const textNode of targets) {
    const text = textNode.nodeValue || ''
    const tl = text.toLowerCase()
    const frag = document.createDocumentFragment()
    let i = 0
    let idx = tl.indexOf(lower, i)
    while (idx !== -1) {
      if (idx > i) frag.appendChild(document.createTextNode(text.slice(i, idx)))
      const mark = document.createElement('mark')
      mark.setAttribute('data-qs', '1')
      mark.style.cssText = 'background:#fde68a;color:#0a0f1e;border-radius:2px;padding:0 1px;'
      mark.textContent = text.slice(idx, idx + q.length)
      frag.appendChild(mark)
      count++
      i = idx + q.length
      idx = tl.indexOf(lower, i)
    }
    if (i < text.length) frag.appendChild(document.createTextNode(text.slice(i)))
    textNode.parentNode?.replaceChild(frag, textNode)
  }
  container.querySelector('mark[data-qs]')?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  return count
}
