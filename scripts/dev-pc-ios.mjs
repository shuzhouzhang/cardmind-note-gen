import { spawn } from 'node:child_process'

const pnpmCommand = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
const simulatorName = process.env.IOS_SIMULATOR?.trim() || 'iPhone 17 Pro'
const tauriDevConfig = '{"build":{"beforeDevCommand":""}}'
const devServerUrl = 'http://127.0.0.1:3456'
const children = new Map()

let shuttingDown = false

function startProcess(label, args) {
  console.log(`[dev:pc-ios] Starting ${label}...`)

  const child = spawn(pnpmCommand, args, {
    stdio: 'inherit',
    env: process.env,
    detached: process.platform !== 'win32',
  })

  children.set(label, child)

  child.on('exit', (code, signal) => {
    children.delete(label)

    if (shuttingDown) return

    // --no-watch exits after the app has been installed and launched.
    if (label === 'iOS simulator' && code === 0) {
      console.log(`[dev:pc-ios] NoteGen launched on ${simulatorName}.`)
      return
    }

    const reason = signal ? `signal ${signal}` : `code ${code ?? 1}`
    console.error(`[dev:pc-ios] ${label} stopped with ${reason}.`)
    shutdown(code ?? 1)
  })

  child.on('error', (error) => {
    console.error(`[dev:pc-ios] Failed to start ${label}:`, error)
    shutdown(1)
  })

  return child
}

function stopProcess(child, signal) {
  if (!child.pid || child.exitCode !== null) return

  try {
    if (process.platform === 'win32') {
      child.kill(signal)
    } else {
      process.kill(-child.pid, signal)
    }
  } catch (error) {
    if (error.code !== 'ESRCH') throw error
  }
}

function shutdown(exitCode = 0) {
  if (shuttingDown) return
  shuttingDown = true

  for (const child of children.values()) {
    stopProcess(child, 'SIGTERM')
  }

  const forceExitTimer = setTimeout(() => {
    for (const child of children.values()) {
      stopProcess(child, 'SIGKILL')
    }
    process.exit(exitCode)
  }, 1500)

  forceExitTimer.unref()

  if (children.size === 0) {
    process.exit(exitCode)
  }

  Promise.allSettled(
    [...children.values()].map(
      (child) => new Promise((resolve) => child.once('exit', resolve)),
    ),
  ).then(() => process.exit(exitCode))
}

async function devServerIsReady() {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 1000)

  try {
    const response = await fetch(devServerUrl, {
      signal: controller.signal,
      redirect: 'manual',
    })
    return response.status > 0
  } catch {
    return false
  } finally {
    clearTimeout(timeout)
  }
}

async function waitForDevServer() {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 500))

    if (await devServerIsReady()) {
      console.log(`[dev:pc-ios] Dev server is ready at ${devServerUrl}.`)
      return
    }

    if (!children.has('desktop app')) {
      throw new Error('The desktop app stopped before the dev server became ready.')
    }
  }

  throw new Error(`Timed out waiting for ${devServerUrl}.`)
}

process.on('SIGINT', () => shutdown(130))
process.on('SIGTERM', () => shutdown(143))

try {
  const devServerAlreadyRunning = await devServerIsReady()
  // iOS generation updates files under src-tauri/. Without this flag the
  // desktop watcher treats those generated files as Rust source changes and
  // repeatedly rebuilds while Xcode holds the same Cargo target lock.
  const desktopArgs = ['tauri', 'dev', '--no-watch']

  if (devServerAlreadyRunning) {
    console.log(`[dev:pc-ios] Reusing the dev server at ${devServerUrl}.`)
    desktopArgs.push('--config', tauriDevConfig)
  }

  startProcess('desktop app', desktopArgs)

  if (!devServerAlreadyRunning) {
    // Desktop Tauri owns beforeDevCommand and starts pnpm dev exactly once.
    await waitForDevServer()
  }

  startProcess('iOS simulator', [
    'tauri',
    'ios',
    'dev',
    simulatorName,
    '--no-watch',
    '--config',
    tauriDevConfig,
  ])
} catch (error) {
  console.error(`[dev:pc-ios] ${error.message}`)
  shutdown(1)
}
