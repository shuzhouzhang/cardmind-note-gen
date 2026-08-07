import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

const pnpmCommand = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
const deviceName = process.env.IOS_DEVICE?.trim() || 'iPhone'
const bundleIdentifier = 'com.codexu.NoteGen'
const projectRoot = process.cwd()

function run(command, args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: projectRoot,
      stdio: 'inherit',
      env: process.env,
    })

    child.on('error', reject)
    child.on('exit', (code, signal) => {
      if (signal) {
        reject(new Error(`${command} was stopped by signal ${signal}.`))
        return
      }

      if (code !== 0) {
        reject(new Error(`${command} exited with code ${code ?? 1}.`))
        return
      }

      resolvePromise()
    })
  })
}

function findBuiltApp() {
  const candidates = [
    resolve(projectRoot, 'src-tauri/gen/apple/build/note-gen_iOS.xcarchive/Products/Applications/NoteGen.app'),
    resolve(projectRoot, 'src-tauri/gen/apple/build/Payload/NoteGen.app'),
  ]

  return candidates.find((candidate) => existsSync(candidate))
}

try {
  console.log('[deploy:iphone] Building the production iOS app...')
  await run(pnpmCommand, [
    'tauri',
    'ios',
    'build',
    '--export-method',
    'debugging',
  ])

  const appPath = findBuiltApp()
  if (!appPath) {
    throw new Error('The iOS build completed, but NoteGen.app was not found.')
  }

  console.log(`[deploy:iphone] Installing NoteGen on ${deviceName}...`)
  await run('xcrun', [
    'devicectl',
    'device',
    'install',
    'app',
    '--device',
    deviceName,
    appPath,
  ])

  console.log(`[deploy:iphone] Launching NoteGen on ${deviceName}...`)
  await run('xcrun', [
    'devicectl',
    'device',
    'process',
    'launch',
    '--device',
    deviceName,
    '--terminate-existing',
    bundleIdentifier,
  ])

  console.log(`[deploy:iphone] NoteGen was deployed to ${deviceName}.`)
} catch (error) {
  console.error(`[deploy:iphone] ${error.message}`)
  process.exit(1)
}
