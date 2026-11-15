import { useCallback, useEffect, useMemo, useState } from 'react'

import {
  buildArchivePackage,
  downloadArchivePackage,
  listArchiveFiles,
  listArchivePackages,
  listArchiveWindows,
  previewPlanFiles,
  readScheme,
  resetArchiveData,
  resumeFailedFiles,
  runArchive,
  uploadArchivePackage,
} from '@/api/archive-service'
import type {
  ArchivePackage,
  ArchiveWindow,
  PartitionFile,
  TierName,
} from '@/data/archive-types'
import { listEntries } from '@/api/local-service'
import type { EntryRow } from '@/data/types'

type TabKey = 'files' | 'windows' | 'packages'

const tierBadgeClass: Record<TierName, string> = {
  热层: 'hot',
  冷层: 'cold',
  待归档: 'wait',
  已过期: 'expired',
}

function statusBadgeClass(status: string): string {
  if (status === '已归档') {
    return 'ok'
  }
  if (status === '归档失败') {
    return 'fail'
  }
  return 'idle'
}

export default function ArchivePanel() {
  const [plans, setPlans] = useState<EntryRow[]>([])
  const [planId, setPlanId] = useState(0)
  const [simulateFailure, setSimulateFailure] = useState(false)
  const [tab, setTab] = useState<TabKey>('files')
  const [files, setFiles] = useState<PartitionFile[]>([])
  const [windows, setWindows] = useState<ArchiveWindow[]>([])
  const [packages, setPackages] = useState<ArchivePackage[]>([])
  const [queueCount, setQueueCount] = useState(0)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')

  const scheme = useMemo(() => (planId ? readScheme(planId) : null), [planId, files, windows])

  const refresh = useCallback(() => {
    const planRows = listEntries('lakezone').items
    setPlans(planRows)
    // 方案列表被外部状态流转改动时保持当前选择，当前选择失效才回退到第一条。
    if (!planRows.some((row) => Number(row.id) === planId)) {
      setPlanId(Number(planRows[0]?.id ?? 0))
    }
    setFiles(planId ? previewPlanFiles(planId) : [])
    setWindows(listArchiveWindows())
    setPackages(listArchivePackages())
    setQueueCount(
      listEntries('snapshot').items.filter(
        (row: EntryRow) => row['来源分区文件'] && String(row.status) === '待创建',
      ).length,
    )
  }, [planId])

  useEffect(() => {
    refresh()
  }, [refresh])

  function notify(ok: boolean, text: string) {
    if (ok) {
      setMessage(text)
      setError('')
    } else {
      setError(text)
      setMessage('')
    }
  }

  function handlePreview() {
    setError('')
    setMessage('')
    if (!planId) {
      setError('请先选择分区方案')
      return
    }
    setFiles(previewPlanFiles(planId))
    setTab('files')
    setMessage(`已按方案 ${scheme?.方案编号} 的分区字段、粒度、保留天数与冷热分层重新计算分区文件`)
  }

  function handleRun() {
    const result = runArchive(planId, simulateFailure)
    notify(result.ok, result.message)
    refresh()
    if (result.ok) {
      setTab('windows')
    }
  }

  function handleResume(windowId: string) {
    const result = resumeFailedFiles(windowId)
    notify(result.ok, result.message)
    refresh()
  }

  function handleBuild(windowId: string) {
    const result = buildArchivePackage(windowId)
    notify(result.ok, result.message)
    refresh()
    if (result.ok && result.blob && result.record) {
      const url = URL.createObjectURL(result.blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = result.record.文件名
      document.body.appendChild(anchor)
      anchor.click()
      document.body.removeChild(anchor)
      URL.revokeObjectURL(url)
    }
  }

  function handleUpload(packageId: string) {
    const result = uploadArchivePackage(packageId)
    notify(result.ok, result.message)
    refresh()
  }

  function handleDownload(packageId: string) {
    downloadArchivePackage(packageId)
  }

  function handleReset() {
    const result = resetArchiveData()
    notify(result.ok, result.message)
    refresh()
  }

  const planWindows = windows.filter((item) => item.planId === planId)
  const planWindowIds = new Set(planWindows.map((item) => item.windowId))
  const planPackages = packages.filter((item) => planWindowIds.has(item.windowId))
  const planFileCount = files.length
  const archivedCount = files.filter((file) => file.归档状态 === '已归档').length
  const failedCount = files.filter((file) => file.归档状态 === '归档失败').length
  const waitingCount = files.filter((file) => file.冷热分层 === '待归档').length

  return (
    <section className="archive-panel">
      <h3>分区归档执行</h3>
      <p className="panel-desc">
        按分区字段、分区粒度、保留天数与冷热分层计算分区方案，生成可核对的分区文件与归档保留结论；
        归档窗口幂等，失败可从失败分区续做，待创建快照自动同步到版本快照页。
      </p>

      <div className="archive-controls">
        <label className="filter-item">
          <span>选择分区方案</span>
          <select value={planId} onChange={(event) => setPlanId(Number(event.target.value))}>
            {plans.map((plan) => (
              <option key={String(plan.id)} value={Number(plan.id)}>
                {String(plan['方案编号'])}｜{String(plan['目标表名'])}｜{String(plan.status)}
              </option>
            ))}
          </select>
        </label>
        <button className="btn" type="button" onClick={handlePreview}>计算分区方案</button>
        <label className="check-pill">
          <input
            type="checkbox"
            checked={simulateFailure}
            onChange={(event) => setSimulateFailure(event.target.checked)}
          />
          模拟部分分区归档失败
        </label>
        <button className="btn primary" type="button" onClick={handleRun}>执行分区归档</button>
        <button className="btn ghost" type="button" onClick={handleReset}>清空归档演示数据</button>
      </div>

      {scheme && (
        <div className="scheme-note">
          <div>
            <strong>当前口径：</strong>
            分区字段「{scheme.分区字段}」 · {scheme.粒度文案} · 保留 {scheme.保留天数} 天 ·
            热层 {scheme.热层阈值天数} 天 / 冷层 {scheme.冷层阈值天数} 天 ·
            归档路径 {scheme.归档路径前缀}
          </div>
          <div className="mono">口径签名：{scheme.口径签名}</div>
          {scheme.权威方案编号 && scheme.权威方案编号 !== scheme.方案编号 ? (
            <div style={{ color: '#b42318' }}>
              新旧口径冲突：目标表已启用方案 {scheme.权威方案编号}，本方案归档会被拦截，旧分区文件按原口径保留。
            </div>
          ) : (
            scheme.冲突方案.length > 0 && (
              <div>
                同目标表存在其它口径方案（{scheme.冲突方案.map((item) => `${item.方案编号} ${item.状态}`).join('；')}），
                其历史口径文件将冻结保留，不参与本窗口归档。
              </div>
            )
          )}
          <div>
            当前方案文件 {planFileCount} 个：待归档 {waitingCount} · 已归档 {archivedCount} · 归档失败 {failedCount}
          </div>
        </div>
      )}

      <div className="queue-banner">
        版本快照页「待创建」队列当前共 {queueCount} 条备份记录，随本次归档结论实时变化（历史手工快照不受影响）。
      </div>

      <div className="tab-row">
        <button className={`tab-btn ${tab === 'files' ? 'active' : ''}`} type="button" onClick={() => setTab('files')}>
          分区文件与保留结论
        </button>
        <button className={`tab-btn ${tab === 'windows' ? 'active' : ''}`} type="button" onClick={() => setTab('windows')}>
          归档窗口（{planWindows.length}）
        </button>
        <button className={`tab-btn ${tab === 'packages' ? 'active' : ''}`} type="button" onClick={() => setTab('packages')}>
          压缩包与上传（{planPackages.length}）
        </button>
      </div>

      {message && <p className="page-foot" style={{ color: '#15803d' }}>{message}</p>}
      {error && <p className="page-foot error-text">{error}</p>}

      {tab === 'files' && (
        <table className="data-table">
          <thead>
            <tr>
              <th>分区文件</th>
              <th>分区值</th>
              <th>年龄(天)</th>
              <th>冷热分层</th>
              <th>归档状态</th>
              <th>归档路径</th>
              <th>口径来源</th>
              <th>关联快照</th>
            </tr>
          </thead>
          <tbody>
            {files.map((file) => (
              <tr key={file.fileId}>
                <td className="mono">{file.文件名}</td>
                <td>{file.分区值}</td>
                <td>{file.年龄天数}</td>
                <td>
                  <span className={`badge ${tierBadgeClass[file.冷热分层]}`}>{file.冷热分层}</span>
                </td>
                <td>
                  <span className={`badge ${statusBadgeClass(file.归档状态)}`}>{file.归档状态}</span>
                  {file.最近错误 && <div className="mono" style={{ color: '#b42318' }}>{file.最近错误}</div>}
                </td>
                <td className="mono">{file.归档路径}</td>
                <td>
                  {file.历史口径 ? (
                    <span className="badge history">历史口径冻结</span>
                  ) : (
                    <span className="badge idle">当前口径</span>
                  )}
                </td>
                <td className="mono">{file.关联快照编号 ?? '—'}</td>
              </tr>
            ))}
            {files.length === 0 && (
              <tr><td className="empty-state" colSpan={8}>选择方案后点击「计算分区方案」生成可核对的分区文件</td></tr>
            )}
          </tbody>
        </table>
      )}

      {tab === 'windows' && (
        <table className="data-table">
          <thead>
            <tr>
              <th>归档窗口</th>
              <th>目标表</th>
              <th>窗口日期</th>
              <th>应归档</th>
              <th>成功/失败</th>
              <th>窗口状态</th>
              <th>触发次数</th>
              <th>最近触发</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {planWindows.map((item) => (
              <tr key={item.windowId}>
                <td className="mono">{item.windowId}</td>
                <td>{item.目标表名}</td>
                <td>{item.窗口日期}</td>
                <td>{item.应归档文件数}</td>
                <td>{item.成功文件数} / {item.失败文件数}</td>
                <td>
                  <span className={`badge ${item.状态 === '全部成功' ? 'ok' : 'fail'}`}>{item.状态}</span>
                </td>
                <td>{item.触发次数}</td>
                <td>{item.最近触发时间}</td>
                <td className="row-actions">
                  {item.失败文件数 > 0 ? (
                    <button className="link" type="button" onClick={() => handleResume(item.windowId)}>
                      从失败分区续做
                    </button>
                  ) : (
                    <span style={{ color: '#94a3b8', fontSize: 12 }}>无失败分区</span>
                  )}
                  <button className="link" type="button" onClick={() => handleBuild(item.windowId)}>
                    打包归档结果
                  </button>
                </td>
              </tr>
            ))}
            {planWindows.length === 0 && (
              <tr><td className="empty-state" colSpan={9}>还没有归档窗口，点击「执行分区归档」生成（同窗口重复触发只产生一次结果）</td></tr>
            )}
          </tbody>
        </table>
      )}

      {tab === 'packages' && (
        <table className="data-table">
          <thead>
            <tr>
              <th>压缩包</th>
              <th>归档窗口</th>
              <th>生成时间</th>
              <th>文件数</th>
              <th>大小</th>
              <th>对齐的待创建快照</th>
              <th>内容校验</th>
              <th>上传状态</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {planPackages.map((item) => (
              <tr key={item.packageId}>
                <td className="mono">{item.文件名}</td>
                <td className="mono">{item.windowId}</td>
                <td>{item.生成时间}</td>
                <td>{item.文件数量}</td>
                <td>{item.大小KB}KB</td>
                <td className="mono">{item.快照队列编号.join('、') || '—'}</td>
                <td className="mono">{item.内容校验}</td>
                <td>
                  <span className={`badge ${item.上传状态 === '已上传' ? 'uploaded' : 'pending-upload'}`}>
                    {item.上传状态}
                  </span>
                  {item.上传时间 && <div style={{ fontSize: 12, color: '#64748b' }}>{item.上传时间}</div>}
                </td>
                <td className="row-actions">
                  <button className="link" type="button" onClick={() => handleDownload(item.packageId)}>下载</button>
                  {item.上传状态 === '未上传' && (
                    <button className="link" type="button" onClick={() => handleUpload(item.packageId)}>
                      上传压缩包
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {planPackages.length === 0 && (
              <tr><td className="empty-state" colSpan={9}>当前方案还没有压缩包，在「归档窗口」页签对窗口执行「打包归档结果」</td></tr>
            )}
          </tbody>
        </table>
      )}

      {listArchiveFiles().length > 0 && (
        <footer className="page-foot">
          <span>
            提示：已归档文件在续做时不会被回滚；同窗口重复触发归档会被幂等拦截；
            压缩包清单与版本快照待创建队列一致才允许上传。
          </span>
        </footer>
      )}
    </section>
  )
}
