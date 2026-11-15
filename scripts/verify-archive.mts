// 分区归档领域规则验证：esbuild 单入口打包后用 node 运行，不进入 src 构建产物。
import { createRequire } from 'node:module'
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

const require = createRequire('/workspace/frontend/package.json')
const { build } = require('esbuild') as typeof import('esbuild')

// ---- 浏览器环境模拟 ----
const storage = new Map<string, string>()
const localStorageMock = {
  getItem: (key: string) => (storage.has(key) ? storage.get(key)! : null),
  setItem: (key: string, value: string) => {
    storage.set(key, value)
  },
  removeItem: (key: string) => {
    storage.delete(key)
  },
}
;(globalThis as { window?: unknown }).window = { localStorage: localStorageMock }
;(globalThis as { localStorage?: unknown }).localStorage = localStorageMock
;(globalThis as { URL?: unknown }).URL = { createObjectURL: () => 'blob:mock', revokeObjectURL: () => {} }
;(globalThis as { document?: unknown }).document = {
  createElement: () => ({ click() {}, remove() {} }),
  body: { appendChild() {}, removeChild() {} },
}
;(globalThis as { Blob?: unknown }).Blob = class MockBlob {
  parts: unknown[]
  options: unknown
  size: number
  constructor(parts: unknown[], options?: unknown) {
    this.parts = parts
    this.options = options
    this.size = parts.reduce((sum: number, part: unknown) => {
      if (part instanceof ArrayBuffer) return sum + part.byteLength
      if (part instanceof Uint8Array) return sum + part.length
      return sum
    }, 0)
  }
}

const outfile = '/tmp/archive-verify/bundle.mjs'
mkdirSync(dirname(outfile), { recursive: true })

// 单入口打包：archiveService 与 localStore 共用同一份模块实例与 localStorage。
await build({
  entryPoints: ['/workspace/frontend/src/verify-entry.ts'],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  outfile,
  alias: { '@': '/workspace/frontend/src' },
  logLevel: 'silent',
})

const { archiveService: service, localStore } = await import(outfile) as {
  archiveService: typeof import('/workspace/frontend/src/api/archive-service')
  localStore: typeof import('/workspace/frontend/src/data/local-store')
}

let pass = 0
let fail = 0
function check(name: string, condition: boolean, detail = '') {
  if (condition) {
    pass += 1
    console.log(`  ✔ ${name}`)
  } else {
    fail += 1
    console.error(`  ✘ ${name} ${detail}`)
  }
}

console.log('\n== 1. 分区方案计算与冷热分层 ==')
const scheme1 = service.readScheme(1)
check('方案1 解析出按天粒度', scheme1?.粒度 === 'day')
check('方案1 保留天数=30', scheme1?.保留天数 === 30)
check('方案1 热层阈值=7、冷层阈值=15', scheme1?.热层阈值天数 === 7 && scheme1?.冷层阈值天数 === 15)
const files1 = service.previewPlanFiles(1)
const tiers = new Set(files1.map((f) => f.冷热分层))
check('分区文件覆盖四个冷热层级', ['热层', '冷层', '待归档', '已过期'].every((t) => tiers.has(t)))
check('按天分区回看 60 个分区', files1.length === 60)

console.log('\n== 2. 新旧口径冲突：已启用方案为准 ==')
const scheme2 = service.readScheme(2)
check('方案2 识别到同表已启用权威方案 LAKE-0001', scheme2?.权威方案编号 === 'LAKE-0001')
const blocked = service.runArchive(2, false)
check('非启用方案归档被拦截', blocked.ok === false)
check('拦截提示含「以已启用方案为准」', blocked.message.includes('以已启用方案为准'))
check('被拦截方案不产生归档窗口', service.listArchiveWindows().length === 0)

console.log('\n== 3. 归档窗口幂等 + 部分失败 + 待创建快照同步 ==')
const run1 = service.runArchive(1, true)
check('方案1 归档执行成功', run1.ok && !run1.reused)
check('部分失败：有失败文件', (run1.window?.失败文件数 ?? 0) >= 1)
const window1 = run1.window!
check('成功+失败=应归档', window1.成功文件数 + window1.失败文件数 === window1.应归档文件数)
const pendingFromArchive = localStore
  .listRows('snapshot')
  .filter((r) => r['来源分区文件'] && String(r.status) === '待创建')
check('版本快照模块出现对应待创建队列', pendingFromArchive.length === window1.应归档文件数)
check('失败分区的备份记录标记异常', pendingFromArchive.some((r) => r.abnormal))
check(
  '历史手工快照 3 条原样保留',
  localStore.listRows('snapshot').filter((r) => !r['来源分区文件']).length === 3,
)

const run2 = service.runArchive(1, true)
check('同窗口重复触发被幂等拦截', run2.reused === true && run2.ok)
check('重复触发不新增窗口', service.listArchiveWindows().length === 1)
check('重复触发触发次数仍为 1', service.listArchiveWindows()[0].触发次数 === 1)
const beforeResumeArchived = service
  .listArchiveFiles()
  .filter((f) => f.归档状态 === '已归档').length

console.log('\n== 4. 失败分区续做，不回滚已成功文件 ==')
const resume = service.resumeFailedFiles(window1.windowId)
check('续做成功', resume.ok)
check('续做数量=失败文件数', resume.resumed === window1.失败文件数)
const afterWindow = service.listArchiveWindows()[0]
check('窗口状态变为全部成功', afterWindow.状态 === '全部成功' && afterWindow.失败文件数 === 0)
const afterFiles = service.listArchiveFiles()
check(
  '已归档文件数只增不减（成功文件未回滚）',
  afterFiles.filter((f) => f.归档状态 === '已归档').length >= beforeResumeArchived,
)
check(
  '不存在未归档的窗口文件',
  !afterFiles.some((f) => f.所属窗口 === window1.windowId && f.归档状态 === '未归档'),
)
const queueAfterResume = localStore
  .listRows('snapshot')
  .filter((r) => r['来源分区文件'] && String(r.status) === '待创建')
check('续做后队列长度不变（备份记录原地更新）', queueAfterResume.length === window1.应归档文件数)
check('续做后失败备份异常标记清除', !queueAfterResume.some((r) => r.abnormal))
check('续做后存储介质更新为归档冷备介质', queueAfterResume.every((r) => r['存储介质'] === '归档冷备介质'))

console.log('\n== 5. 压缩包与上传：内容对齐跨模块待创建队列 ==')
const pkg = service.buildArchivePackage(window1.windowId)
check('压缩包生成成功', pkg.ok && pkg.blob !== null)
check('包内文件数=窗口已归档文件数', pkg.record?.文件数量 === afterWindow.成功文件数)
check('包记录对齐待创建快照编号', (pkg.record?.快照队列编号.length ?? 0) === afterWindow.成功文件数)
const upload = service.uploadArchivePackage(pkg.record!.packageId)
check('上传成功', upload.ok && upload.record?.上传状态 === '已上传')
check('上传结论含队列一致说明', upload.message.includes('版本快照'))

// 模拟队列漂移：把一条待创建备份手动生效，新包打包阶段就应被拦截（不产生新包）。
const snapshots = localStore.listRows('snapshot')
const queueRowIndex = snapshots.findIndex((r) => r['来源分区文件'] && String(r.status) === '待创建')
const driftedRow = { ...snapshots[queueRowIndex], status: '已生效', pending: false }
snapshots[queueRowIndex] = driftedRow
localStore.saveRows('snapshot', snapshots)
const packageCountBefore = service.listArchivePackages().length
const pkgDrift = service.buildArchivePackage(window1.windowId)
check('队列漂移后打包被拒绝', pkgDrift.ok === false)
check('被拒绝时不产生新压缩包记录', service.listArchivePackages().length === packageCountBefore)
const pkg2 = service.buildArchivePackage(window1.windowId)
// 已存在的旧包在上传阶段同样要被二次核对拦截。
const upload2 = service.uploadArchivePackage(pkg.record!.packageId)
check('旧包在队列漂移后上传被拒绝', upload2.ok === false)
check('漂移拦截返回结果而非抛异常', pkg2.ok === false && typeof pkg2.message === 'string')

// 恢复队列后重新打包上传成功。
const restored = localStore.listRows('snapshot')
restored[queueRowIndex] = { ...driftedRow, status: '待创建', pending: true }
localStore.saveRows('snapshot', restored)
const pkg3 = service.buildArchivePackage(window1.windowId)
const upload3 = service.uploadArchivePackage(pkg3.record!.packageId)
check('队列恢复后新包可上传', upload3.ok)

console.log('\n== 6. 口径冲突下旧分区文件按原口径冻结保留 ==')
// 停用方案1、启用方案2，再执行方案2：方案2 成为权威；方案1 产生的文件签名不同，应被冻结。
const plans = localStore.listRows('lakezone')
localStore.saveRows(
  'lakezone',
  plans.map((p) => {
    if (Number(p.id) === 1) return { ...p, status: '已停用', pending: true }
    if (Number(p.id) === 2) return { ...p, status: '已启用', pending: false }
    return p
  }),
)
const preview2 = service.previewPlanFiles(2)
const frozen = preview2.filter((f) => f.历史口径)
check('方案2 预览中包含方案1 留下的历史口径文件', frozen.length > 0)
check('历史口径文件仍保持已归档结论', frozen.every((f) => f.归档状态 === '已归档'))
const runNew = service.runArchive(2, false)
check('新权威方案可产出新窗口', runNew.ok && !runNew.reused)
check('新窗口不含历史口径文件', runNew.files.every((f) => f.历史口径 !== true))
check(
  '历史口径文件在新窗口执行后依旧未回滚',
  service.listArchiveFiles().filter((f) => f.历史口径 && f.归档状态 === '已归档').length === frozen.length,
)

console.log('\n== 7. 重置：清理归档产物但保留历史手工快照 ==')
const reset = service.resetArchiveData()
check('重置成功', reset.ok)
check(
  '重置后无归档文件/窗口/包',
  service.listArchiveFiles().length === 0 &&
    service.listArchiveWindows().length === 0 &&
    service.listArchivePackages().length === 0,
)
const remainSnapshots = localStore.listRows('snapshot')
check(
  '历史手工快照仍为 3 条且取值不变',
  remainSnapshots.filter((r) => !r['来源分区文件']).length === 3,
)
check('归档产生的待创建备份已清掉', !remainSnapshots.some((r) => r['来源分区文件']))

writeFileSync('/tmp/archive-verify/storage-dump.json', JSON.stringify(Object.fromEntries(storage), null, 2))
console.log(`\n结果：通过 ${pass} 项，失败 ${fail} 项`)
if (fail > 0) {
  process.exit(1)
}
