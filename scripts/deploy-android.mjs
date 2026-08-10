import { spawn } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { resolve } from 'node:path'

const projectRoot = process.cwd()
const pnpmCommand = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
const packageIdentifier = 'com.codexu.NoteGen'
const mainActivity = `${packageIdentifier}/.MainActivity`
const requestedDevice = process.env.ANDROID_DEVICE?.trim() || ''
const androidMinSdk = '24'

function resolveAdbCommand() {
  if (process.env.ANDROID_ADB?.trim()) return process.env.ANDROID_ADB.trim()

  const executable = process.platform === 'win32' ? 'adb.exe' : 'adb'
  for (const sdkRoot of [process.env.ANDROID_HOME, process.env.ANDROID_SDK_ROOT]) {
    if (!sdkRoot?.trim()) continue
    const candidate = resolve(sdkRoot, 'platform-tools', executable)
    if (existsSync(candidate)) return candidate
  }
  return executable
}

const adbCommand = resolveAdbCommand()

function run(command, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: projectRoot,
      stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
      env: options.env || process.env,
    })
    let stdout = ''
    let stderr = ''

    if (options.capture) {
      child.stdout.on('data', chunk => { stdout += chunk })
      child.stderr.on('data', chunk => { stderr += chunk })
    }

    child.on('error', error => {
      const pathHint = command === adbCommand
        ? ' Ensure Android SDK platform-tools is on PATH, or set ANDROID_ADB to the adb executable.'
        : ''
      reject(new Error(`Failed to start ${command}.${pathHint} ${error.message}`))
    })
    child.on('exit', (code, signal) => {
      if (signal) {
        reject(new Error(`${command} was stopped by signal ${signal}.`))
        return
      }
      if (code !== 0) {
        reject(new Error(`${command} exited with code ${code ?? 1}.${stderr.trim() ? `\n${stderr.trim()}` : ''}`))
        return
      }
      resolvePromise(stdout.trim())
    })
  })
}

function resolveNdkRoot() {
  const configuredRoots = [
    process.env.ANDROID_NDK_ROOT,
    process.env.ANDROID_NDK,
    process.env.ANDROID_NDK_HOME,
    process.env.NDK_HOME,
  ].map(path => path?.trim()).filter(Boolean)

  for (const path of configuredRoots) {
    if (existsSync(resolve(path, 'toolchains', 'llvm', 'prebuilt'))) return path
  }

  for (const sdkRoot of [process.env.ANDROID_HOME, process.env.ANDROID_SDK_ROOT]) {
    if (!sdkRoot?.trim()) continue
    const ndkDirectory = resolve(sdkRoot, 'ndk')
    if (!existsSync(ndkDirectory)) continue
    const installed = readdirSync(ndkDirectory)
      .map(name => resolve(ndkDirectory, name))
      .filter(path => statSync(path).isDirectory())
      .sort((left, right) => right.localeCompare(left, undefined, { numeric: true }))
    const detected = installed.find(path => existsSync(resolve(path, 'toolchains', 'llvm', 'prebuilt')))
    if (detected) return detected
  }

  throw new Error('Android NDK was not found. Install it with Android Studio, or set ANDROID_NDK_ROOT.')
}

function createAndroidBuildEnv(target) {
  const ndkRoot = resolveNdkRoot()
  const prebuiltRoot = resolve(ndkRoot, 'toolchains', 'llvm', 'prebuilt')
  const hostDirectory = readdirSync(prebuiltRoot)
    .map(name => resolve(prebuiltRoot, name))
    .find(path => statSync(path).isDirectory())
  if (!hostDirectory) throw new Error(`No NDK LLVM toolchain was found under ${prebuiltRoot}.`)

  const binDirectory = resolve(hostDirectory, 'bin')
  const targetTools = {
    aarch64: {
      cargoTriple: 'aarch64_linux_android',
      compiler: `aarch64-linux-android${androidMinSdk}-clang`,
    },
    armv7: {
      cargoTriple: 'armv7_linux_androideabi',
      compiler: `armv7a-linux-androideabi${androidMinSdk}-clang`,
    },
    i686: {
      cargoTriple: 'i686_linux_android',
      compiler: `i686-linux-android${androidMinSdk}-clang`,
    },
    x86_64: {
      cargoTriple: 'x86_64_linux_android',
      compiler: `x86_64-linux-android${androidMinSdk}-clang`,
    },
  }
  const tools = targetTools[target]
  const compiler = resolve(binDirectory, tools.compiler)
  const archiver = resolve(binDirectory, 'llvm-ar')
  const ranlib = resolve(binDirectory, 'llvm-ranlib')
  for (const path of [compiler, archiver, ranlib]) {
    if (!existsSync(path)) throw new Error(`Required Android NDK tool was not found: ${path}`)
  }

  return {
    ...process.env,
    ANDROID_NDK_ROOT: ndkRoot,
    ANDROID_NDK: ndkRoot,
    ANDROID_NDK_HOME: ndkRoot,
    NDK_HOME: ndkRoot,
    PATH: `${binDirectory}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH || ''}`,
    [`CC_${tools.cargoTriple}`]: compiler,
    [`AR_${tools.cargoTriple}`]: archiver,
    [`RANLIB_${tools.cargoTriple}`]: ranlib,
  }
}

async function ensureAndroidProject(buildEnv) {
  const wrapperName = process.platform === 'win32' ? 'gradlew.bat' : 'gradlew'
  const wrapperPath = resolve(projectRoot, 'src-tauri', 'gen', 'android', wrapperName)
  if (existsSync(wrapperPath)) return

  console.log('[deploy:android] Android project is incomplete; initializing the Gradle wrapper...')
  await run(pnpmCommand, [
    'tauri',
    'android',
    'init',
    '--ci',
    '--skip-targets-install',
  ], { env: buildEnv })

  if (!existsSync(wrapperPath)) {
    throw new Error(`Tauri Android initialization completed, but ${wrapperPath} was not created.`)
  }
}

async function adb(args, options) {
  return await run(adbCommand, args, options)
}

async function selectDevice() {
  const output = await adb(['devices', '-l'], { capture: true })
  const devices = output.split(/\r?\n/).slice(1).map(line => line.trim()).filter(Boolean).map(line => {
    const [serial, state = 'unknown'] = line.split(/\s+/, 3)
    return { serial, state, line }
  })

  if (requestedDevice) {
    const selected = devices.find(device => device.serial === requestedDevice)
    if (!selected) throw new Error(`Android device "${requestedDevice}" was not found by adb.`)
    if (selected.state !== 'device') {
      throw new Error(`Android device "${requestedDevice}" is ${selected.state}; unlock it and authorize USB debugging.`)
    }
    return selected.serial
  }

  const ready = devices.filter(device => device.state === 'device')
  if (ready.length === 0) {
    const unauthorized = devices.find(device => device.state === 'unauthorized')
    if (unauthorized) {
      throw new Error(`Android device "${unauthorized.serial}" is unauthorized; unlock it and accept the USB debugging prompt.`)
    }
    throw new Error('No authorized Android device was found. Connect the phone and enable USB debugging.')
  }
  if (ready.length > 1) {
    throw new Error(`Multiple Android devices are connected (${ready.map(device => device.serial).join(', ')}). Set ANDROID_DEVICE to the target serial.`)
  }
  return ready[0].serial
}

function tauriTargetForAbi(abi) {
  const targets = {
    'arm64-v8a': 'aarch64',
    'armeabi-v7a': 'armv7',
    x86: 'i686',
    x86_64: 'x86_64',
  }
  const target = targets[abi]
  if (!target) throw new Error(`Unsupported Android ABI "${abi}".`)
  return target
}

function collectApks(directory) {
  if (!existsSync(directory)) return []
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = resolve(directory, entry.name)
    if (entry.isDirectory()) return collectApks(path)
    return entry.isFile() && entry.name.endsWith('.apk') ? [path] : []
  })
}

function findBuiltApk(target) {
  const outputRoot = resolve(projectRoot, 'src-tauri/gen/android/app/build/outputs/apk')
  const candidates = collectApks(outputRoot)
    .filter(path => path.toLowerCase().includes('debug'))
    .filter(path => !path.toLowerCase().includes('androidtest'))
    .sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs)
  return candidates.find(path => path.includes(target)) || candidates[0]
}

try {
  console.log('[deploy:android] Looking for an authorized Android phone...')
  const serial = await selectDevice()
  const [model, abi] = await Promise.all([
    adb(['-s', serial, 'shell', 'getprop', 'ro.product.model'], { capture: true }),
    adb(['-s', serial, 'shell', 'getprop', 'ro.product.cpu.abi'], { capture: true }),
  ])
  const target = tauriTargetForAbi(abi)
  const buildEnv = createAndroidBuildEnv(target)
  console.log(`[deploy:android] Target: ${model || 'Android device'} (${serial}, ${abi}).`)
  console.log(`[deploy:android] Android NDK: ${buildEnv.ANDROID_NDK_ROOT}.`)
  await ensureAndroidProject(buildEnv)
  console.log(`[deploy:android] Building the ${target} debug APK...`)

  await run(pnpmCommand, [
    'tauri',
    'android',
    'build',
    '--debug',
    '--apk',
    '--target',
    target,
  ], { env: buildEnv })

  const apkPath = findBuiltApk(target)
  if (!apkPath) throw new Error('The Android build completed, but a debug APK was not found.')

  console.log(`[deploy:android] Installing ${apkPath}...`)
  await adb(['-s', serial, 'install', '-r', '-d', apkPath])

  console.log(`[deploy:android] Launching NoteGen on ${model || serial}...`)
  await adb(['-s', serial, 'shell', 'am', 'start', '-S', '-n', mainActivity])
  console.log(`[deploy:android] NoteGen was deployed to ${model || serial}.`)
} catch (error) {
  console.error(`[deploy:android] ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}
