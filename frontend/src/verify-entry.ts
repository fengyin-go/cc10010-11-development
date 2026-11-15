// 验证用统一入口：把归档服务与本地存储放在同一个模块图里，避免重复打包导致状态不一致。
export * as archiveService from './api/archive-service'
export * as localStore from './data/local-store'
