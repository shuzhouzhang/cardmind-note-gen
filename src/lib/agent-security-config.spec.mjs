import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

function read(relativePath) {
  return readFileSync(path.join(repoRoot, relativePath), 'utf8')
}

test('disabled Agent capabilities are absent from the prompt and active catalog', () => {
  const prompt = read('src/lib/ai/system-prompt.ts')
  const registry = read('src/lib/agent/tool-registry.ts')
  const systemTools = read('src/lib/agent/tools/system-tools.ts')
  const chatContent = read('src/app/core/main/chat/chat-content.tsx')
  const genericChat = read('src/lib/ai/chat.ts')

  assert.doesNotMatch(prompt, /mcp_(?:list|call)_tools|skill_(?:list|load|execute)|memory_(?:list|create|delete)/i)
  assert.doesNotMatch(registry, /name:\s*['"](?:mcp_|skill_|memory_)/i)
  assert.doesNotMatch(systemTools, /select[_-]?skill|load[_-]?skill|execute[_-]?skill|skillManager|runtime-script-skill/i)
  assert.doesNotMatch(chatContent, /McpToolCallCard|mcp-tool-call/i)
  assert.doesNotMatch(genericChat, /mcpTools|mcp\/tools|useMcpStore/)
  assert.equal(existsSync(path.join(repoRoot, 'src/app/mobile/chat/components/mcp-selector.tsx')), false)
  assert.equal(existsSync(path.join(repoRoot, 'src/app/core/main/chat/mcp-tool-call.tsx')), false)
})

test('Tauri does not expose MCP process or runtime-installer commands', () => {
  for (const entrypoint of ['src-tauri/src/main.rs', 'src-tauri/src/lib.rs']) {
    const source = read(entrypoint)
    assert.doesNotMatch(source, /start_mcp_stdio_server|send_mcp_message|install_mcp_runtime/)
    assert.doesNotMatch(source, /McpServerManager|RuntimeInstallManager/)
  }
})

test('Tauri production policy disables globals, frames, objects, and remote scripts', () => {
  const config = JSON.parse(read('src-tauri/tauri.conf.json'))
  const security = config.app.security

  assert.equal(config.app.withGlobalTauri, false)
  assert.match(security.csp, /script-src 'self'(?:;|\s)/)
  assert.doesNotMatch(security.csp, /script-src[^;]*https:/)
  assert.match(security.csp, /object-src 'none'/)
  assert.match(security.csp, /frame-src 'none'/)
  assert.match(security.devCsp, /http:\/\/localhost:3456/)
  assert.match(security.devCsp, /ws:\/\/localhost:3456/)
})

test('CardMind cannot update itself from the upstream NoteGen release feed', () => {
  const config = JSON.parse(read('src-tauri/tauri.conf.json'))
  const rustMain = read('src-tauri/src/main.rs')
  const capabilities = JSON.parse(read('src-tauri/capabilities/desktop.json'))
  const about = read('src/app/core/setting/about/setting-about.tsx')
  const layout = read('src/app/core/layout.tsx')
  const cargoManifest = read('src-tauri/Cargo.toml')
  const cargoLock = read('src-tauri/Cargo.lock')
  const settings = read('src/stores/setting.ts')

  assert.deepEqual(config.plugins?.updater?.endpoints || [], [])
  assert.doesNotMatch(rustMain, /tauri_plugin_updater/)
  assert.equal(capabilities.permissions.includes('updater:default'), false)
  assert.doesNotMatch(about, /<Updater\b|\.\/updater/)
  assert.doesNotMatch(layout, /useUpdateStore|initUpdateStore/)
  assert.doesNotMatch(cargoManifest, /tauri-plugin-updater/)
  assert.doesNotMatch(cargoLock, /tauri-plugin-updater/)
  assert.doesNotMatch(settings, /autoUpdate|setAutoUpdate/)
  assert.equal(existsSync(path.join(repoRoot, '.github/workflows/release.yml')), false)
  assert.equal(existsSync(path.join(repoRoot, 'src/app/core/setting/about/updater.tsx')), false)
})

test('MCP configuration stays local even when sensitive-sync opt-out is disabled', () => {
  const exclusions = read('src/config/sync-exclusions.ts')

  assert.match(exclusions, /ALWAYS_SYNC_EXCLUDED_FIELDS[\s\S]*['"]mcp\.servers['"]/)
  assert.match(exclusions, /ALWAYS_SYNC_EXCLUDED_FIELDS[\s\S]*['"]mcp\.selectedServerIds['"]/)
})

test('the built-in model catalog contains no source-shipped provider credential', () => {
  const modelConfig = read('src/app/model-config.ts')

  assert.doesNotMatch(modelConfig, /sk-[A-Za-z0-9_-]{16,}/)
  assert.match(modelConfig, /apiKey:\s*['"]['"]/)
})
