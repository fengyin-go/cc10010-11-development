import { useCallback, useEffect, useMemo, useState } from 'react'

import { downloadEntries, listEntries, moduleMeta, runAction as applyAction } from '@/api/local-service'
import type { EntryRow } from '@/data/types'
import ArchivePanel from './ArchivePanel'

const meta = moduleMeta('lakezone')
const columns = [
  "方案编号",
  "目标表名",
  "分区字段",
  "分区粒度",
  "保留天数",
  "冷热分层",
  "归档路径",
  "小文件合并"
]
const actions = [
  "提交校验",
  "启用方案",
  "停用方案"
]
const statuses = [
  "草稿",
  "待校验",
  "已启用",
  "已停用"
]

export default function LakezoneView() {
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
      setErrorMessage(error instanceof Error ? error.message : '湖区分区列表读取失败')
    }
  }, [filters])

  useEffect(() => {
    reload()
  }, [reload])

  // 同目标表出现多条方案即存在新旧口径冲突，页面给出提示，执行时以已启用方案为准。
  const conflictTables = useMemo(() => {
    const countByTable = new Map<string, number>()
    rows.forEach((row) => {
      const name = String(row['目标表名'] ?? '')
      countByTable.set(name, (countByTable.get(name) ?? 0) + 1)
    })
    return new Set([...countByTable.entries()].filter(([, count]) => count > 1).map(([name]) => name))
  }, [rows])

  const stats = useMemo(() => [
    { label: "分区方案总数", value: rows.length },
    { label: "已启用方案", value: rows.filter((row) => String(row.status) === "已启用").length },
    { label: "待校验方案", value: rows.filter((row) => String(row.status) === "待校验").length },
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
    <section className="page" data-module="lakezone">
      <header className="page-head">
        <div>
          <h2>湖区分区管理</h2>
          <p className="page-desc">维护湖区分区方案的输入、执行约束与结果记录，并按方案口径执行分区归档，为湖区分区提供可验证的数据工程流程。</p>
        </div>
        <div className="page-actions">
          <button className="btn primary" type="button" onClick={() => setErrorMessage('分区方案登记入口尚未接入审批流')}>
            登记分区方案
          </button>
          <button className="btn" type="button" onClick={() => downloadEntries(meta.key)}>
            导出湖区分区清单
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

      <p className="status-legend">
        {statuses.map((status: string) => (
          <span key={status} className="legend-item">
            {status}：{rows.filter((row) => String(row.status) === status).length}
          </span>
        ))}
        {conflictTables.size > 0 && (
          <span className="legend-item" style={{ background: '#fee2e2', color: '#b42318' }}>
            新旧口径冲突表：{[...conflictTables].join('、')}
          </span>
        )}
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
            <th>当前状态</th>
            <th>口径提示</th>
            <th>可执行动作</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={String(row.id)}>
              {columns.map((column) => <td key={column}>{row[column] ?? '—'}</td>)}
              <td>{row.status}</td>
              <td>
                {conflictTables.has(String(row['目标表名'] ?? '')) ? (
                  <span className="badge fail">
                    {String(row.status) === '已启用' ? '当前权威口径' : '新旧口径冲突，待启用方案裁决'}
                  </span>
                ) : (
                  <span className="badge idle">口径唯一</span>
                )}
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
              <td className="empty-state" colSpan={columns.length + 3}>暂无湖区分区数据，可先登记分区方案</td>
            </tr>
          )}
        </tbody>
      </table>

      <ArchivePanel />

      <footer className="page-foot">
        <span>共 {total} 条湖区分区记录</span>
        {errorMessage && <span className="error-text">{errorMessage}</span>}
      </footer>
    </section>
  )
}
