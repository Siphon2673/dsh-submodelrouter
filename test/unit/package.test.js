import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../', import.meta.url))
const packageJson = JSON.parse(readFileSync(`${root}package.json`, 'utf8'))
const patch = readFileSync(`${root}cordis.patch.yml`, 'utf8')
const readme = readFileSync(`${root}README.md`, 'utf8')
const readmeZh = readFileSync(`${root}README.zh.md`, 'utf8')
const client = readFileSync(`${root}client.js`, 'utf8')

test('the manifest declares a dual-face bundle without a DSH version gate', () => {
  assert.equal(packageJson.name, 'dsh-submodelrouter')
  assert.equal(packageJson.type, 'module')
  assert.equal(packageJson.engines?.dsh, undefined)
  assert.equal(packageJson.dsh.manifestVersion, 1)
  assert.deepEqual(packageJson.dsh.bundle.patch, './cordis.patch.yml')
  assert.equal(packageJson.dsh.client.platform, 'web')
  assert.ok(packageJson.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-plugin-manager'))
  assert.ok(packageJson.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-settings'))
  assert.ok(packageJson.dsh.client.inject.includes('@deepseek-ai/dsh-client-locale'))
  assert.ok(packageJson.dsh.client.inject.includes('@deepseek-ai/dsh-api-remotes'))
  assert.equal(packageJson.exports['.'], './index.js')
  assert.equal(packageJson.exports['./client'], './client.js')
  assert.equal(packageJson.exports['./locale/*.json'], './locale/*.json')
  assert.equal(packageJson.exports['./icon'], './icon.svg')
})

test('genuine DSH runtime peers are ungated and development pins are exact', () => {
  const dshPeers = Object.keys(packageJson.peerDependencies ?? {}).filter(
    (name) => name === '@deepseek-ai/dsh' || name.startsWith('@deepseek-ai/dsh-'),
  )
  assert.ok(dshPeers.length > 0)
  for (const name of dshPeers) {
    assert.equal(packageJson.peerDependencies[name], '*', name)
    assert.equal(packageJson.devDependencies[name], '0.2.2-rc.5', name)
  }
  assert.equal(packageJson.devDependencies['@deepseek-ai/dsh-tool-subagent'], '0.2.2-rc.5')
  assert.equal(packageJson.devDependencies['@deepseek-ai/dsh-tool-testkit'], '0.2.2-rc.5')
})

test('the bundle patch inserts one uniquely identified row', () => {
  assert.match(patch, /- insert:/)
  assert.match(patch, /id: submodelrouter/)
  assert.match(patch, /name: dsh-submodelrouter/)
})

test('the published files carry both halves and display resources', () => {
  for (const file of ['index.js', 'client.js', 'cordis.patch.yml', 'icon.svg', 'README.md', 'README.zh.md', 'LICENSE']) {
    assert.ok(packageJson.files.includes(file), file)
    assert.ok(statSync(`${root}${file}`).isFile(), file)
  }
  assert.ok(packageJson.files.includes('lib/*.js'))
  assert.ok(packageJson.files.includes('locale/*.json'))
  assert.match(client, /window\.__ModuleLoader__\.load\(/)
  assert.match(client, /id: 'dsh-submodelrouter'/)
})

test('locale resources carry display metadata in English and Simplified Chinese', () => {
  for (const locale of ['en', 'zh']) {
    const dictionary = JSON.parse(readFileSync(`${root}locale/${locale}.json`, 'utf8'))
    assert.ok(dictionary.meta.title.length > 0)
    assert.ok(dictionary.meta.description.length > 0)
  }
})

test('README declares the tested and structurally compatible DSH versions', () => {
  const versions = [...readme.matchAll(/\|\s*`([^`]+)`\s*\|\s*(Tested|Unverified)/g)].map((match) => match[1])
  assert.deepEqual(versions, ['0.2.2-rc.5'])
  assert.match(readme, /\|\s*`0\.2\.2-rc\.1`\s*\|\s*Structurally compatible, not in the test matrix\s*\|/)
  assert.doesNotMatch(readme, /### Known incompatible/)
  assert.doesNotMatch(readme, /`0\.2\.2-rc\.2`\s*–\s*`0\.2\.2-rc\.5`/)
  assert.match(readme, /declares no `engines.dsh` and no pinned DSH peer version/i)
  assert.match(readme, /local in-process `spawn`/)
  assert.match(readme, /agentOptions/)
  assert.match(readme, /Parent fallback/)
  assert.match(readme, /Plugin-owned Save|one plugin-owned Save/i)
  assert.match(readme, /Identification is structural/)
  assert.match(readme, /native `\{ kind: 'activation', name \}`/)
  assert.match(readmeZh, /\|\s*`0\.2\.2-rc\.5`\s*\|\s*已测试\s*\|/)
  assert.match(readmeZh, /\|\s*`0\.2\.2-rc\.1`\s*\|\s*结构兼容，未纳入测试矩阵\s*\|/)
  assert.doesNotMatch(readmeZh, /### 已知不兼容/)
  assert.doesNotMatch(readmeZh, /`0\.2\.2-rc\.2`\s*–\s*`0\.2\.2-rc\.5`/)
})
