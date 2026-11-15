import { listRows, saveRows } from '@/data/local-store'
import {
  loadFiles,
  loadPackages,
  loadWindows,
  resetArchive,
  saveFiles,
  savePackages,
  saveWindows,
} from '@/data/archive-store'
import type { EntryRow } from '@/data/types'
import type {
  ArchiveGranularity,
  ArchivePackage,
  ArchiveScheme,
  ArchiveWindow,
  PartitionFile,
  TierName,
  WindowStatus,
} from '@/data/archive-types'
import { buildZip } from './zip-writer'

const LAKEZONE_KEY = 'lakezone'
const SNAPSHOT_KEY = 'snapshot'
const PLAN_STATUS_ENABLED = '已启用'

// 模拟环境无法真连归档存储：用一个内存标记模拟「上传到归档介质」。
const uploadedBlobs = new Map<string, Blob>()

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

function formatDate(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

function formatDateTime(date: Date): string {
  return `${formatDate(date)} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

function parseInteger(value: unknown, fallback: number): number {
  const matched = String(value ?? '').match(/-?\d+/)
  if (!matched) {
    return fallback
  }
  const parsed = Number(matched[0])
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function parseGranularity(value: unknown): { 粒度: ArchiveGranularity; 文案: string } {
  const text = String(value ?? '')
  if (text.includes('小时') || text.toLowerCase().includes('hour')) {
    return { 粒度: 'hour', 文案: '按小时' }
  }
  if (text.includes('月') || text.toLowerCase().includes('month')) {
    return { 粒度: 'month', 文案: '按月' }
  }
  return { 粒度: 'day', 文案: '按天' }
}

/** 冷热分层形如「热层7天/冷层30天」；缺省按保留天数的 1/3、2/3 切分。 */
function parseTierThresholds(rawTier: unknown, retainDays: number): { hot: number; cold: number } {
  const text = String(rawTier ?? '')
  const hotMatched = text.match(/热[^0-9]*(\d+)\s*天/)
  const coldMatched = text.match(/冷[^0-9]*(\d+)\s*天/)
  const hot = hotMatched ? Number(hotMatched[1]) : Math.max(1, Math.floor(retainDays / 3))
  const cold = coldMatched ? Number(coldMatched[1]) : Math.max(hot + 1, Math.floor((retainDays * 2) / 3))
  return {
    hot: Math.min(hot, retainDays),
    cold: Math.min(Math.max(cold, hot), retainDays),
  }
}

function buildSignature(field: string, gran: ArchiveGranularity, retain: number, hot: number, cold: number): string {
  return `${field}|${gran}|r${retain}|h${hot}|c${cold}`
}

/** 读取一个湖区分区方案并解析为可核对的分区口径。 */
export function readScheme(planId: number): ArchiveScheme | null {
  const plans = listRows(LAKEZONE_KEY)
  const plan = plans.find((row) => Number(row.id) === planId)
  if (!plan) {
    return null
  }
  const 目标表名 = String(plan['目标表名'] ?? '')
  const 分区字段 = String(plan['分区字段'] ?? 'dt')
  const { 粒度, 文案 } = parseGranularity(plan['分区粒度'])
  const 保留天数 = parseInteger(plan['保留天数'], 30)
  const { hot, cold } = parseTierThresholds(plan['冷热分层'], 保留天数)
  const 归档路径前缀 = String(plan['归档路径'] || `/archive/${目标表名}`)
  const sameTable = plans.filter((row) => String(row['目标表名'] ?? '') === 目标表名 && Number(row.id) !== planId)
  const enabled = sameTable.filter((row) => String(row.status) === PLAN_STATUS_ENABLED)
  const 权威 = enabled[0]
  return {
    planId,
    方案编号: String(plan['方案编号'] ?? `LAKE-${planId}`),
    目标表名,
    分区字段,
    粒度,
    粒度文案: 文案,
    保留天数,
    热层阈值天数: hot,
    冷层阈值天数: cold,
    归档路径前缀,
    口径签名: buildSignature(分区字段, 粒度, 保留天数, hot, cold),
    冲突方案: sameTable.map((row) => ({
      planId: Number(row.id),
      方案编号: String(row['方案编号']),
      状态: String(row.status),
    })),
    权威方案编号: 权威 ? String(权威['方案编号']) : null,
  }
}

/** 回看窗口长度：保证演示数据里能覆盖「热/冷/待归档/已过期」四个层级。 */
function lookbackLimit(gran: ArchiveGranularity): number {
  if (gran === 'hour') {
    return 72
  }
  if (gran === 'month') {
    return 24
  }
  return 60
}

/** 生成从当前时间向前的分区序列（新到旧）。 */
function buildPartitions(scheme: ArchiveScheme, now: Date): { value: string; date: Date; ageDays: number }[] {
  const limit = lookbackLimit(scheme.粒度)
  const result: { value: string; date: Date; ageDays: number }[] = []
  if (scheme.粒度 === 'hour') {
    for (let i = 0; i < limit; i += 1) {
      const date = new Date(now.getTime() - i * 3600 * 1000)
      result.push({
        value: `${formatDate(date)}-${pad(date.getHours())}`,
        date,
        ageDays: Math.floor((now.getTime() - date.getTime()) / (24 * 3600 * 1000)),
      })
    }
    return result
  }
  if (scheme.粒度 === 'month') {
    for (let i = 0; i < limit; i += 1) {
      const date = new Date(now.getFullYear(), now.getMonth() - i, 1)
      const ageDays = Math.floor((now.getTime() - date.getTime()) / (24 * 3600 * 1000))
      result.push({ value: `${date.getFullYear()}-${pad(date.getMonth() + 1)}`, date, ageDays })
    }
    return result
  }
  for (let i = 0; i < limit; i += 1) {
    const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i)
    result.push({ value: formatDate(date), date, ageDays: i })
  }
  return result
}

function tierOf(ageDays: number, scheme: ArchiveScheme): TierName {
  if (ageDays > scheme.保留天数) {
    return '已过期'
  }
  if (ageDays > scheme.冷层阈值天数) {
    return '待归档'
  }
  if (ageDays > scheme.热层阈值天数) {
    return '冷层'
  }
  return '热层'
}

/**
 * 按当前方案口径计算分区文件清单，同时把历史口径文件（新旧分区口径冲突时
 * 已生成的旧文件）合并进来并冻结：旧文件沿用原口径结论，不参与新窗口归档。
 */
export function previewPlanFiles(planId: number): PartitionFile[] {
  const scheme = readScheme(planId)
  if (!scheme) {
    return []
  }
  const now = new Date()
  const historical = loadFiles().filter(
    (file) => file.目标表名 === scheme.目标表名 && file.口径签名 !== scheme.口径签名,
  )
  const existingByKey = new Map(
    loadFiles()
      .filter((file) => file.planId === planId && file.口径签名 === scheme.口径签名)
      .map((file) => [`${file.planId}#${file.分区值}`, file]),
  )

  const calculated: PartitionFile[] = buildPartitions(scheme, now).map((part) => {
    const fileId = `PF-${planId}-${part.value}`
    const tier = tierOf(part.ageDays, scheme)
    const previous = existingByKey.get(`${planId}#${part.value}`)
    const base: PartitionFile = previous
      ? { ...previous }
      : {
          fileId,
          planId,
          方案编号: scheme.方案编号,
          目标表名: scheme.目标表名,
          分区字段: scheme.分区字段,
          分区值: part.value,
          分区路径: `${scheme.目标表名}/${scheme.分区字段}=${part.value}`,
          文件名: `part-${part.value}.parquet`,
          数据日期: formatDate(part.date),
          年龄天数: part.ageDays,
          冷热分层: tier,
          是否进入归档窗口: false,
          归档状态: '未归档',
          归档路径: '—',
          口径签名: scheme.口径签名,
          历史口径: false,
          所属窗口: null,
          关联快照编号: null,
          最近错误: null,
          更新时间: formatDateTime(now),
        }
    // 重新计算只刷新「可核对结论」字段；归档状态等执行结论保持历史值，不回滚。
    base.年龄天数 = part.ageDays
    base.冷热分层 = tier
    base.数据日期 = formatDate(part.date)
    base.分区路径 = `${scheme.目标表名}/${scheme.分区字段}=${part.value}`
    return base
  })

  // 旧口径文件始终排在前面并标注历史口径，方便核对「旧分区文件按原口径保留」。
  return [
    ...historical.map((file) => ({ ...file, 历史口径: true })),
    ...calculated,
  ]
}

function nextSnapshotId(rows: EntryRow[]): number {
  return rows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
}

function snapshotCode(rows: EntryRow[], id: number): string {
  return `SNAP-${String(id).padStart(4, '0')}`
}

function deterministicSizeKB(file: PartitionFile): number {
  let hash = 0
  for (let i = 0; i < file.fileId.length; i += 1) {
    hash = (hash * 31 + file.fileId.charCodeAt(i)) >>> 0
  }
  return 64 + (hash % 448)
}

/**
 * 归档文件与版本快照模块的待创建队列做 upsert：
 * 已存在的备份记录原地更新（编号不变、取值随本次结论变化），新文件则追加待创建快照。
 */
function upsertSnapshotForFile(file: PartitionFile, nowText: string): EntryRow[] {
  const rows = listRows(SNAPSHOT_KEY)
  const existingIndex = rows.findIndex((row) => row['来源分区文件'] === file.fileId)
  if (existingIndex >= 0) {
    const current = rows[existingIndex]
    const updated: EntryRow = {
      ...current,
      status: '待创建',
      pending: true,
      abnormal: file.归档状态 === '归档失败',
      目标表名: file.目标表名,
      快照时间: nowText.slice(0, 10),
      快照大小: `${deterministicSizeKB(file)}KB`,
      存储介质: file.归档状态 === '归档失败' ? '待补建（归档介质未确认）' : '归档冷备介质',
      过期策略: `随分区方案${file.方案编号}保留口径`,
      恢复校验: file.归档状态 === '归档失败' ? '待续做校验' : '待创建后校验',
      依赖快照: file.所属窗口 ?? '—',
      来源方案: file.方案编号,
      来源分区文件: file.fileId,
      归档窗口: file.所属窗口 ?? '—',
    }
    const next = [...rows]
    next[existingIndex] = updated
    saveRows(SNAPSHOT_KEY, next)
    file.关联快照编号 = String(current['快照编号'])
    return next
  }
  const id = nextSnapshotId(rows)
  const code = snapshotCode(rows, id)
  const row: EntryRow = {
    id,
    status: '待创建',
    pending: true,
    abnormal: file.归档状态 === '归档失败',
    快照编号: code,
    目标表名: file.目标表名,
    快照时间: nowText.slice(0, 10),
    快照大小: `${deterministicSizeKB(file)}KB`,
    存储介质: file.归档状态 === '归档失败' ? '待补建（归档介质未确认）' : '归档冷备介质',
    过期策略: `随分区方案${file.方案编号}保留口径`,
    恢复校验: file.归档状态 === '归档失败' ? '待续做校验' : '待创建后校验',
    依赖快照: file.所属窗口 ?? '—',
    来源方案: file.方案编号,
    来源分区文件: file.fileId,
    归档窗口: file.所属窗口 ?? '—',
  }
  const next = [...rows, row]
  saveRows(SNAPSHOT_KEY, next)
  file.关联快照编号 = code
  return next
}

function windowKey(planId: number, dayText: string): string {
  return `WIN-${planId}-${dayText}`
}

export interface ArchiveExecutionResult {
  ok: boolean
  message: string
  window: ArchiveWindow | null
  files: PartitionFile[]
  reused: boolean
}

/**
 * 执行一次分区归档：
 * 1. 新旧分区口径冲突时，非启用方案不允许产出，已启用方案为准；旧口径文件冻结保留。
 * 2. 同一归档窗口（方案 + 当天）重复触发幂等，只返回首次结论，不产生第二次结果。
 * 3. 可模拟部分文件失败；成功文件落「已归档」，失败文件落「归档失败」等待续做。
 * 4. 待创建快照随结论 upsert 进版本快照模块（跨模块队列同步）。
 */
export function runArchive(planId: number, simulatePartialFailure: boolean): ArchiveExecutionResult {
  const scheme = readScheme(planId)
  if (!scheme) {
    return { ok: false, message: '没有找到对应的分区方案', window: null, files: [], reused: false }
  }
  const now = new Date()
  const dayText = formatDate(now)
  const nowText = formatDateTime(now)
  const key = windowKey(planId, dayText)

  // 幂等：同一归档窗口只允许产生一次结果。
  const windows = loadWindows()
  const existed = windows.find((item) => item.窗口键 === key)
  if (existed) {
    const files = loadFiles().filter((file) => existed.分区文件.includes(file.fileId))
    return {
      ok: true,
      reused: true,
      window: existed,
      files,
      message: `归档窗口 ${existed.windowId} 已存在，重复触发被拦截，沿用首次结论（成功 ${existed.成功文件数} / 失败 ${existed.失败文件数}）`,
    }
  }

  // 口径冲突：同目标表存在已启用的其它方案时，以已启用方案为准。
  const conflicts: string[] = []
  if (scheme.权威方案编号 && scheme.权威方案编号 !== scheme.方案编号) {
    return {
      ok: false,
      reused: false,
      window: null,
      files: previewPlanFiles(planId),
      message: `目标表 ${scheme.目标表名} 存在已启用方案 ${scheme.权威方案编号}，新旧分区口径冲突，以已启用方案为准；本方案不产出新归档，旧分区文件按原口径保留`,
    }
  }
  if (scheme.冲突方案.length > 0) {
    conflicts.push(
      `同目标表另有方案 ${scheme.冲突方案.map((item) => `${item.方案编号}（${item.状态}）`).join('、')}，其历史口径文件已冻结保留，本窗口仅按当前口径归档`,
    )
  }

  const planFiles = previewPlanFiles(planId).filter((file) => !file.历史口径)
  const candidates = planFiles.filter(
    (file) => file.冷热分层 === '待归档' && file.归档状态 !== '已归档',
  )
  if (candidates.length === 0) {
    return {
      ok: false,
      reused: false,
      window: null,
      files: planFiles,
      message: '当前没有进入归档窗口的冷分区文件（需要年龄超过冷层阈值且未过保留天数），无需归档',
    }
  }

  const windowId = `AW-${planId}-${dayText.replace(/-/g, '')}`
  const allFiles = loadFiles()
  // 先把同目标表的旧口径文件持久化冻结：口径签名不同即代表新旧分区口径冲突，
  // 旧文件沿用原口径结论，后续窗口、续做、打包都不能改动它们。
  allFiles.forEach((file) => {
    if (file.目标表名 === scheme.目标表名 && file.口径签名 !== scheme.口径签名) {
      file.历史口径 = true
    }
  })
  const fileMap = new Map(allFiles.map((file) => [file.fileId, file]))
  const windowFileIds: string[] = []
  let success = 0
  let failed = 0

  candidates.forEach((file, index) => {
    const live = fileMap.get(file.fileId) ?? file
    // 模拟部分失败：让每个窗口的第二个候选文件归档失败，便于演示失败续做。
    const willFail = simulatePartialFailure && index === 1
    live.是否进入归档窗口 = true
    live.所属窗口 = windowId
    live.更新时间 = nowText
    if (willFail) {
      live.归档状态 = '归档失败'
      live.归档路径 = '—'
      live.最近错误 = '归档介质写入超时，等待从失败分区续做'
      failed += 1
    } else {
      live.归档状态 = '已归档'
      live.归档路径 = schemeArchivePrefix(live, scheme)
      live.最近错误 = null
      success += 1
    }
    upsertSnapshotForFile(live, nowText)
    windowFileIds.push(live.fileId)
    if (!fileMap.has(live.fileId)) {
      allFiles.push(live)
    }
  })
  saveFiles(allFiles)

  const status: WindowStatus = failed > 0 ? '部分失败' : '全部成功'
  const record: ArchiveWindow = {
    windowId,
    窗口键: key,
    planId,
    方案编号: scheme.方案编号,
    目标表名: scheme.目标表名,
    窗口日期: dayText,
    归档路径前缀: scheme.归档路径前缀,
    应归档文件数: candidates.length,
    成功文件数: success,
    失败文件数: failed,
    状态: status,
    触发次数: 1,
    首次触发时间: nowText,
    最近触发时间: nowText,
    分区文件: windowFileIds,
    冲突说明: conflicts,
    包记录: [],
  }
  saveWindows([...windows, record])

  return {
    ok: true,
    reused: false,
    window: record,
    files: allFiles.filter((file) => windowFileIds.includes(file.fileId)),
    message: `归档窗口 ${windowId} 执行完成：应归档 ${candidates.length} 个，成功 ${success} 个，失败 ${failed} 个；待创建快照已同步到版本快照页`,
  }
}

// 归档路径拼接抽成小工具，保持与分区路径同口径。函数声明会提升，runArchive 可直接调用。
function schemeArchivePrefix(live: PartitionFile, scheme: ArchiveScheme): string {
  return `${scheme.归档路径前缀}/${scheme.分区字段}=${live.分区值}/${live.文件名}`
}

export interface ResumeResult {
  ok: boolean
  message: string
  window: ArchiveWindow | null
  resumed: number
}

/**
 * 从失败分区续做：只处理该窗口的「归档失败」文件。
 * 已成功文件不触碰，保证已归档文件不能被回滚为未归档。
 */
export function resumeFailedFiles(windowId: string): ResumeResult {
  const windows = loadWindows()
  const window = windows.find((item) => item.windowId === windowId)
  if (!window) {
    return { ok: false, message: '没有找到对应的归档窗口', window: null, resumed: 0 }
  }
  const scheme = readScheme(window.planId)
  if (!scheme) {
    return { ok: false, message: '分区方案已不存在，无法续做', window, resumed: 0 }
  }
  const nowText = formatDateTime(new Date())
  const files = loadFiles()
  const failedFiles = files.filter(
    (file) => file.所属窗口 === windowId && file.归档状态 === '归档失败',
  )
  if (failedFiles.length === 0) {
    return { ok: false, message: `窗口 ${windowId} 没有待续做的失败分区`, window, resumed: 0 }
  }

  let resumed = 0
  failedFiles.forEach((file) => {
    file.归档状态 = '已归档'
    file.归档路径 = schemeArchivePrefix(file, scheme)
    file.最近错误 = null
    file.更新时间 = nowText
    resumed += 1
    upsertSnapshotForFile(file, nowText)
  })
  saveFiles(files)

  const nextWindow: ArchiveWindow = {
    ...window,
    成功文件数: window.成功文件数 + resumed,
    失败文件数: Math.max(0, window.失败文件数 - resumed),
    状态: window.失败文件数 - resumed <= 0 ? '全部成功' : '部分失败',
    最近触发时间: nowText,
  }
  saveWindows(windows.map((item) => (item.windowId === windowId ? nextWindow : item)))

  return {
    ok: true,
    resumed,
    window: nextWindow,
    message: `窗口 ${windowId} 已从失败分区续做 ${resumed} 个文件，已成功文件保持已归档未回滚，待创建备份记录已同步更新`,
  }
}

/** 版本快照模块里由分区归档产生的待创建队列（跨模块队列读取口）。 */
export function getSnapshotQueue(): EntryRow[] {
  return listRows(SNAPSHOT_KEY).filter(
    (row) => row['来源分区文件'] && String(row.status) === '待创建',
  )
}

/** 打包前校验：窗口文件与版本快照页的待创建队列必须一致；不一致时返回错误说明而不是抛异常。 */
function checkQueueConsistency(
  window: ArchiveWindow,
  files: PartitionFile[],
): { ok: true; queue: EntryRow[] } | { ok: false; message: string } {
  const queue = getSnapshotQueue()
  const queueIds = new Set(queue.map((row) => String(row['快照编号'])))
  const missing: string[] = []
  files
    .filter((file) => window.分区文件.includes(file.fileId))
    .forEach((file) => {
      if (!file.关联快照编号 || !queueIds.has(file.关联快照编号)) {
        missing.push(file.fileId)
      }
    })
  if (missing.length > 0) {
    return {
      ok: false,
      message: `压缩包内容与版本快照待创建队列不一致，缺失快照的分区：${missing.join('、')}，请先在版本快照页核对队列`,
    }
  }
  return { ok: true, queue }
}

export interface PackageBuildResult {
  ok: boolean
  message: string
  record: ArchivePackage | null
  blob: Blob | null
}

/** 把归档结果打成压缩包：内容清单与版本快照页待创建队列对齐。 */
export function buildArchivePackage(windowId: string): PackageBuildResult {
  const windows = loadWindows()
  const window = windows.find((item) => item.windowId === windowId)
  if (!window) {
    return { ok: false, message: '没有找到对应的归档窗口', record: null, blob: null }
  }
  const files = loadFiles().filter(
    (file) => window.分区文件.includes(file.fileId) && file.归档状态 === '已归档',
  )
  if (files.length === 0) {
    return { ok: false, message: '窗口内还没有已归档文件，无法打包', record: null, blob: null }
  }

  const consistency = checkQueueConsistency(window, files)
  if (!consistency.ok) {
    return { ok: false, message: consistency.message, record: null, blob: null }
  }
  const queue = consistency.queue
  const now = new Date()
  const nowText = formatDateTime(now)
  const packages = loadPackages()
  const packageId = `PKG-${windowId}-${packages.filter((item) => item.windowId === windowId).length + 1}`
  const 文件名 = `${windowId}-archive.zip`

  const manifest = {
    packageId,
    windowId,
    目标表名: window.目标表名,
    方案编号: window.方案编号,
    生成时间: nowText,
    文件数量: files.length,
    快照队列: files.map((file) => ({
      分区文件: file.fileId,
      分区值: file.分区值,
      归档路径: file.归档路径,
      快照编号: file.关联快照编号,
      快照状态: '待创建',
    })),
    队列一致性: '已与版本快照模块待创建队列核对通过',
  }
  const entries = [
    { name: `${windowId}/manifest.json`, content: JSON.stringify(manifest, null, 2) },
    ...files.map((file) => ({
      name: `${windowId}/${file.分区字段}=${file.分区值}/${file.文件名}`,
      content: [
        `# 分区归档文件（离线模拟内容）`,
        `窗口: ${windowId}`,
        `分区: ${file.分区值}`,
        `口径: ${file.口径签名}`,
        `归档路径: ${file.归档路径}`,
        `关联快照: ${file.关联快照编号 ?? ''}`,
      ].join('\n'),
    })),
  ]
  const blob = buildZip(entries)
  const queueCodes = files
    .map((file) => file.关联快照编号 ?? '')
    .filter((code) => queue.some((row) => String(row['快照编号']) === code))

  let checksum = 0
  const checksumText = 文件名 + queueCodes.join('')
  for (let i = 0; i < checksumText.length; i += 1) {
    checksum = (checksum * 31 + checksumText.charCodeAt(i)) >>> 0
  }

  const record: ArchivePackage = {
    packageId,
    windowId,
    文件名,
    生成时间: nowText,
    上传状态: '未上传',
    上传时间: null,
    文件数量: files.length,
    大小KB: Math.max(1, Math.round(blob.size / 1024)),
    快照队列编号: queueCodes,
    内容校验: `ZIP-STORE-${checksum.toString(16).padStart(8, '0')}`,
  }
  const nextWindows = windows.map((item) =>
    item.windowId === windowId ? { ...item, 包记录: [...item.包记录, packageId] } : item,
  )
  savePackages([...packages, record])
  saveWindows(nextWindows)
  uploadedBlobs.set(packageId, blob)

  return {
    ok: true,
    record,
    blob,
    message: `压缩包 ${文件名} 已生成，含 ${files.length} 个归档文件，清单已对齐版本快照待创建队列（${queueCodes.length} 条）`,
  }
}

export interface UploadResult {
  ok: boolean
  message: string
  record: ArchivePackage | null
}

/** 上传压缩包：上传前再次核对跨模块待创建队列，队列漂移则拒绝上传。 */
export function uploadArchivePackage(packageId: string): UploadResult {
  const packages = loadPackages()
  const record = packages.find((item) => item.packageId === packageId)
  if (!record) {
    return { ok: false, message: '没有找到对应的压缩包记录', record: null }
  }
  const windows = loadWindows()
  const window = windows.find((item) => item.windowId === record.windowId)
  if (!window) {
    return { ok: false, message: '压缩包对应的归档窗口已不存在', record }
  }
  const files = loadFiles().filter((file) => window.分区文件.includes(file.fileId))
  const consistency = checkQueueConsistency(window, files)
  if (!consistency.ok) {
    return { ok: false, message: consistency.message, record }
  }

  const liveQueue = getSnapshotQueue().map((row) => String(row['快照编号']))
  const drifted = record.快照队列编号.filter((code) => !liveQueue.includes(code))
  if (drifted.length > 0) {
    return {
      ok: false,
      record,
      message: `待创建队列已发生变化（${drifted.join('、')} 不在队列中），请重新打包后再上传`,
    }
  }

  const nowText = formatDateTime(new Date())
  const updated: ArchivePackage = { ...record, 上传状态: '已上传', 上传时间: nowText }
  savePackages(packages.map((item) => (item.packageId === packageId ? updated : item)))
  return {
    ok: true,
    record: updated,
    message: `压缩包 ${record.文件名} 已上传至归档冷备介质，内容与版本快照待创建队列一致（${record.快照队列编号.length} 条）`,
  }
}

export function downloadArchivePackage(packageId: string): void {
  const blob = uploadedBlobs.get(packageId)
  const record = loadPackages().find((item) => item.packageId === packageId)
  if (!blob || !record) {
    return
  }
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = record.文件名
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

export function listArchiveFiles(): PartitionFile[] {
  return loadFiles()
}

export function listArchiveWindows(): ArchiveWindow[] {
  return loadWindows()
}

export function listArchivePackages(): ArchivePackage[] {
  return loadPackages()
}

export function resetArchiveData(): { ok: boolean; message: string } {
  resetArchive()
  // 只清理由归档能力产生的快照备份记录，历史手工快照原样保留（旧记录取值不变）。
  const snapshots = listRows(SNAPSHOT_KEY).filter((row) => !row['来源分区文件'])
  saveRows(SNAPSHOT_KEY, snapshots)
  return { ok: true, message: '分区归档数据与对应待创建快照已清空，历史快照记录保持不变' }
}
