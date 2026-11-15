/** 纯前端 ZIP 打包：不引第三方依赖，按 ZIP 规范写 STORE（不压缩）条目，可被系统解压工具识别。 */

export interface ZipEntry {
  name: string
  content: string
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i += 1) {
    let crc = i
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1
    }
    table[i] = crc >>> 0
  }
  return table
})()

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff
  for (let i = 0; i < bytes.length; i += 1) {
    crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

function dosTime(date: Date): { time: number; datePart: number } {
  const time =
    (date.getHours() << 11) | (date.getMinutes() << 5) | (Math.floor(date.getSeconds() / 2))
  const datePart =
    (((date.getFullYear() - 1980) & 0x7f) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()
  return { time, datePart: datePart }
}

const encoder = new TextEncoder()

/**
 * 把若干文本条目打成 ZIP 二进制（STORE 模式），返回可下载/上传的 Blob。
 * 清单类文本统一 UTF-8，名称置 UTF-8 标志位，避免中文乱码。
 */
export function buildZip(entries: ZipEntry[]): Blob {
  const now = new Date()
  const { time, datePart } = dosTime(now)
  const localParts: BlobPart[] = []
  const centralParts: BlobPart[] = []
  let offset = 0

  entries.forEach((entry) => {
    const nameBytes = encoder.encode(entry.name)
    const contentBytes = encoder.encode(entry.content)
    const crc = crc32(contentBytes)
    const size = contentBytes.length

    const localHeader = new DataView(new ArrayBuffer(30))
    localHeader.setUint32(0, 0x04034b50, true) // 本地文件头签名
    localHeader.setUint16(4, 20, true) // 解压版本
    localHeader.setUint16(6, 0x0800, true) // UTF-8 名称标志
    localHeader.setUint16(8, 0, true) // STORE
    localHeader.setUint16(10, time, true)
    localHeader.setUint16(12, datePart, true)
    localHeader.setUint32(14, crc, true)
    localHeader.setUint32(18, size, true)
    localHeader.setUint32(22, size, true)
    localHeader.setUint16(26, nameBytes.length, true)
    localHeader.setUint16(28, 0, true)

    localParts.push(localHeader.buffer, nameBytes, contentBytes)
    const localSize = 30 + nameBytes.length + size

    const central = new DataView(new ArrayBuffer(46))
    central.setUint32(0, 0x02014b50, true) // 中央目录签名
    central.setUint16(4, 20, true)
    central.setUint16(6, 20, true)
    central.setUint16(8, 0x0800, true)
    central.setUint16(10, 0, true)
    central.setUint16(12, time, true)
    central.setUint16(14, datePart, true)
    central.setUint32(16, crc, true)
    central.setUint32(20, size, true)
    central.setUint32(24, size, true)
    central.setUint16(28, nameBytes.length, true)
    central.setUint16(30, 0, true)
    central.setUint16(32, 0, true)
    central.setUint16(34, 0, true)
    central.setUint16(36, 0, true)
    central.setUint32(38, 0, true)
    central.setUint32(42, offset, true)

    centralParts.push(central.buffer, nameBytes)
    offset += localSize
  })

  const centralBlob = new Blob(centralParts)
  const centralSize = centralBlob.size
  const centralOffset = offset

  const eocd = new DataView(new ArrayBuffer(22))
  eocd.setUint32(0, 0x06054b50, true) // EOCD 签名
  eocd.setUint16(8, entries.length, true)
  eocd.setUint16(10, entries.length, true)
  eocd.setUint32(12, centralSize, true)
  eocd.setUint32(16, centralOffset, true)
  eocd.setUint16(20, 0, true)

  return new Blob([...localParts, centralBlob, eocd.buffer], { type: 'application/zip' })
}
