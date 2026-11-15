import { useCallback, useEffect, useMemo, useState } from 'react'

import { downloadEntries, listEntries, moduleMeta, runAction as applyAction } from '@/api/local-service'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('snapshot')
const columns = [
  "快照编号",
  "目标表名",
  "快照时间",
  "快照大小",
  "存储介质",
  "过期策略",
  "恢复校验",
  "依赖快照"
]
const actions = [
  "提交创建",
  "生效快照",
  "标记过期"
]
const statuses = [
  "草稿",
  "待创建",
  "已生效",
  "已过期"
]

export default function SnapshotView() {
  const [rows, setRows] = useState<EntryRow[]>([])
  const [total, setTotal] = useState(0)
  const [errorMessage, setErrorMessage] = useState('')
  const [filters, setFilters] = useState<Record<string, string>>({})
  const filterFields = useMemo(() => columns.slice(0, 3), [])

  const reload = useCallback(() => {
    setErrorMessage('')
    try {
      const payload = listEntries(meta.key, filters)
      setRows(payload.items)
      setTotal(payload.total)
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : '版本快照列表读取失败')
    }
  }, [filters])

  useEffect(() => {
    reload()
  }, [reload])

  // 分区归档产生的待创建队列：跨模块同步，随归档/续做/重置结论变化。
  const archiveQueue = useMemo(
    () => rows.filter((row) => row['来源分区文件'] && String(row.status) === '待创建'),
    [rows],
  )
  const abnormalQueue = useMemo(() => archiveQueue.filter((row) => row.abnormal), [archiveQueue])

  const stats = useMemo(() => [
    { label: "快照记录总数", value: rows.length },
    { label: "已生效快照", value: rows.filter((row) => String(row.status) === "已生效").length },
    { label: "待创建快照", value: rows.filter((row) => String(row.status) === "待创建").length },
  ], [rows])

  function runAction(action: string, row: EntryRow) {
    setErrorMessage('')
    const result = applyAction(meta.key, Number(row.id), action)
    if (!result.ok) {
      setErrorMessage(result.message)
      return
    }
    reload()
  }

  return (
    <section className="page" data-module="snapshot">
      <header className="page-head">
        <div>
          <h2>版本快照管理</h2>
          <p className="page-desc">维护版本快照记录的输入、执行约束与结果记录；分区归档产生的待创建快照在此排队，随归档结论同步更新。</p>
        </div>
        <div className="page-actions">
          <button className="btn primary" type="button" onClick={() => setErrorMessage('快照记录登记入口尚未接入审批流')}>
            登记快照记录
          </button>
          <button className="btn" type="button" onClick={() => downloadEntries(meta.key)}>
            导出版本快照清单
          </button>
        </div>
      </header>

      <div className="stat-row">
        {stats.map((item) => (
          <article key={item.label} className="stat-card">
            <span className="stat-label">{item.label}</span>
            <strong className="stat-value">{item.value}</strong>
          </article>
        ))}
      </div>

      <div className="queue-banner">
        分区归档待创建队列：共 {archiveQueue.length} 条备份记录
        {abnormalQueue.length > 0 && `，其中 ${abnormalQueue.length} 条对应归档失败分区，续做成功后自动恢复正常`}
        。压缩包清单与此队列核对一致才允许上传；历史手工快照沿用历史结论，取值不变。
      </div>

      <p className="status-legend">
        {statuses.map((status: string) => (
          <span key={status} className="legend-item">
            {status}：{rows.filter((row) => String(row.status) === status).length}
          </span>
        ))}
      </p>

      <form className="filter-bar" onSubmit={(event) => { event.preventDefault(); reload() }}>
        {filterFields.map((field) => (
          <label key={field} className="filter-item">
            <span>{field}</span>
            <input
              value={filters[field] ?? ''}
              placeholder={`按${field}检索`}
              onChange={(event) => setFilters((prev) => ({ ...prev, [field]: event.target.value }))}
            />
          </label>
        ))}
        <button className="btn" type="submit">查询</button>
        <button className="btn ghost" type="button" onClick={() => setFilters({})}>重置条件</button>
      </form>

      <table className="data-table">
        <thead>
          <tr>
            {columns.map((column) => <th key={column}>{column}</th>)}
            <th>来源</th>
            <th>当前状态</th>
            <th>可执行动作</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={String(row.id)}>
              {columns.map((column) => <td key={column}>{row[column] ?? '—'}</td>)}
              <td>
                {row['来源分区文件'] ? (
                  <span className="badge wait">分区归档 · {String(row['归档窗口'] ?? '—')}</span>
                ) : (
                  <span className="badge idle">历史手工记录</span>
                )}
              </td>
              <td>
                {row.status}
                {row.abnormal && <span className="badge fail" style={{ marginLeft: 6 }}>异常</span>}
              </td>
              <td className="row-actions">
                {actions.map((action) => (
                  <button key={action} className="link" type="button" onClick={() => runAction(action, row)}>
                    {action}
                  </button>
                ))}
              </td>
            </tr>
          ))}
          {rows.length === 0 && (
            <tr>
              <td className="empty-state" colSpan={columns.length + 3}>暂无版本快照数据，可先登记快照记录或在湖区分区执行归档</td>
            </tr>
          )}
        </tbody>
      </table>

      <footer className="page-foot">
        <span>共 {total} 条版本快照记录</span>
        {errorMessage && <span className="error-text">{errorMessage}</span>}
      </footer>
    </section>
  )
}
