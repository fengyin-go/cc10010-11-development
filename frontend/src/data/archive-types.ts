/** 分区归档领域的类型：分区方案计算结果、分区文件、归档窗口、压缩包记录。 */

export type ArchiveGranularity = 'day' | 'month' | 'hour'

export type TierName = '热层' | '冷层' | '待归档' | '已过期'

export type FileArchiveStatus = '未归档' | '已归档' | '归档失败'

export type WindowStatus = '全部成功' | '部分失败'

export type PackageUploadStatus = '未上传' | '已上传'

/** 根据分区字段、分区粒度、保留天数、冷热分层解析出来的分区方案（可核对口径）。 */
export interface ArchiveScheme {
  planId: number
  方案编号: string
  目标表名: string
  分区字段: string
  粒度: ArchiveGranularity
  粒度文案: string
  保留天数: number
  热层阈值天数: number
  冷层阈值天数: number
  归档路径前缀: string
  口径签名: string
  /** 同目标表的其它方案：用于新旧口径冲突判断。 */
  冲突方案: { planId: number; 方案编号: string; 状态: string }[]
  /** 当前已启用的权威方案编号；没有则为 null。 */
  权威方案编号: string | null
}

/** 一个可核对的分区文件及其归档保留结论。 */
export interface PartitionFile {
  fileId: string
  planId: number
  方案编号: string
  目标表名: string
  分区字段: string
  分区值: string
  分区路径: string
  文件名: string
  数据日期: string
  年龄天数: number
  冷热分层: TierName
  是否进入归档窗口: boolean
  归档状态: FileArchiveStatus
  归档路径: string
  /** 生成该文件时的口径签名：字段|粒度|保留|冷热阈值。 */
  口径签名: string
  /** 旧口径文件：沿用历史结论冻结保留，不参与新方案归档、不允许回滚。 */
  历史口径: boolean
  所属窗口: string | null
  关联快照编号: string | null
  最近错误: string | null
  更新时间: string
}

/** 同一归档窗口的一次执行结论；窗口键幂等，重复触发不产生第二次结果。 */
export interface ArchiveWindow {
  windowId: string
  /** 幂等键：方案 + 归档窗口日期（按天）。 */
  窗口键: string
  planId: number
  方案编号: string
  目标表名: string
  窗口日期: string
  归档路径前缀: string
  应归档文件数: number
  成功文件数: number
  失败文件数: number
  状态: WindowStatus
  触发次数: number
  首次触发时间: string
  最近触发时间: string
  分区文件: string[]
  冲突说明: string[]
  包记录: string[]
}

/** 归档结果压缩包及其上传结论，清单与版本快照页的待创建队列保持一致。 */
export interface ArchivePackage {
  packageId: string
  windowId: string
  文件名: string
  生成时间: string
  上传状态: PackageUploadStatus
  上传时间: string | null
  文件数量: number
  大小KB: number
  /** 打包时刻版本快照模块里的待创建队列编号。 */
  快照队列编号: string[]
  内容校验: string
}
