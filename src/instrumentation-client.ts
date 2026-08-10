type WindowWithMarkdownItFix = Window & {
  isSpace?: (code: number) => boolean
}

const appWindow = window as WindowWithMarkdownItFix

// Define isSpace globally before the Markdown editor initializes.
// https://github.com/markdown-it/markdown-it/issues/1082#issuecomment-2749656365
if (typeof appWindow.isSpace === 'undefined') {
  appWindow.isSpace = (code) => (
    code === 0x20
    || code === 0x09
    || code === 0x0A
    || code === 0x0B
    || code === 0x0C
    || code === 0x0D
  )
}

if (window.location.pathname === '/') {
  const userAgent = navigator.userAgent.toLowerCase()
  const isMobile = /android|iphone|ipad|ipod/.test(userAgent)
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
    || (window.innerWidth <= 768 && navigator.maxTouchPoints > 0)

  if (isMobile) {
    let cachedPage: string | null = null

    try {
      cachedPage = window.localStorage.getItem('noteGenMobileCurrentPage')
    } catch {
      // Continue with the default mobile route when storage is unavailable.
    }

    window.location.replace(
      cachedPage?.startsWith('/mobile') ? cachedPage : '/mobile/chat',
    )
  }
}
