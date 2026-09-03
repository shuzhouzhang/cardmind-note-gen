const ALLOWED_MARKDOWN_PROTOCOLS = new Set(['http:', 'https:', 'mailto:'])

/**
 * Markdown links may point to normal web/mail destinations or stay within the
 * rendered document. App-internal protocols and executable/data URLs are not
 * accepted from model output.
 */
export function isSafeMarkdownLink(value) {
  if (typeof value !== 'string') return false

  const raw = value.trim()
  if (!raw || raw.startsWith('//')) return false

  const normalized = raw
    .replace(/&colon;|&#0*58;|&#x0*3a;/gi, ':')
    .replace(/[\u0000-\u0020\u007f]+/g, '')
  const scheme = normalized.match(/^([a-z][a-z0-9+.-]*):/i)

  if (!scheme) {
    return true
  }

  return ALLOWED_MARKDOWN_PROTOCOLS.has(`${scheme[1].toLowerCase()}:`)
}

/** Apply the shared link policy and safe external-link attributes. */
export function configureSafeMarkdown(md) {
  md.validateLink = isSafeMarkdownLink
  md.renderer.rules.link_open = function (tokens, idx, options, _env, self) {
    tokens[idx].attrSet('target', '_blank')
    tokens[idx].attrSet('rel', 'noopener noreferrer')
    tokens[idx].attrSet('referrerpolicy', 'no-referrer')
    return self.renderToken(tokens, idx, options)
  }
  return md
}
