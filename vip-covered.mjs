/**
 * VIP 覆盖预检（只读）。
 *
 * 目的：本地兜底任务与 GitHub Actions 各自跑，谁都不知道对方领过没有。
 * 每次签到前先查一次概念版 SVIP 到期时间，若已覆盖到「明天这个时刻」之后，
 * 说明今天必然已领满（每天上限 8 次 ≈ +45 小时，只要领过一天就至少 +24 小时），
 * 直接跳过真实请求，避免每天无意义的 30002/130012 噪音。
 *
 * 用法：node vip-covered.mjs
 * 退出码：0 = 已覆盖，应跳过；1 = 未覆盖，需要签到；2 = 查询失败（按未覆盖处理）
 */
import fs from 'node:fs'
import path from 'node:path'
import { startService, waitForApi, send, close_api } from './utils/utils.js'
import { buildDeviceCookie } from './utils/device.js'

/** 需要覆盖到多久以后才算「今天已领」：明天此刻 */
const HORIZON_HOURS = 23

const file = path.resolve(process.env.DATA_DIR || './data', 'userinfo.json')
if (!fs.existsSync(file)) {
  console.error('[vip-covered] 凭据不存在，需扫码登录')
  process.exit(1)
}

let accounts = []
try {
  accounts = JSON.parse(fs.readFileSync(file, 'utf8'))
} catch (e) {
  console.error('[vip-covered] 凭据解析失败：' + e.message)
  process.exit(2)
}
if (!Array.isArray(accounts) || accounts.length === 0) {
  console.error('[vip-covered] 凭据为空')
  process.exit(1)
}

/** 解析酷狗时间字符串（北京时间 "YYYY-MM-DD HH:mm:ss"）为 ms */
function parseKugouTime(s) {
  if (!s || typeof s !== 'string') return NaN
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/)
  if (!m) return NaN
  const [, y, mo, d, h, mi, se] = m.map(Number)
  return Date.UTC(y, mo - 1, d, h - 8, mi, se)
}

const api = startService()
let needCheckin = false
let checked = 0

try {
  await waitForApi()
  const horizon = Date.now() + HORIZON_HOURS * 3600 * 1000
  const horizonText = new Date(horizon + 8 * 3600 * 1000)
    .toISOString().replace('T', ' ').slice(0, 19)

  for (const u of accounts) {
    const label = String(u.userid || '').replace(/^(\d{3})\d+(\d{2})$/, '$1***$2')
    const headers = {
      cookie: buildDeviceCookie(u, 'token=' + u.token + '; userid=' + u.userid),
    }
    let detail
    try {
      detail = await send('/user/vip/detail?timestrap=' + Date.now(), 'GET', headers)
    } catch (e) {
      console.error(`[vip-covered] ${label} 查询失败：${e.message}`)
      needCheckin = true
      continue
    }
    const list = (detail && detail.data && detail.data.busi_vip) || []
    const svip = list.find((v) => v && v.product_type === 'svip')
    const endText = svip && svip.vip_end_time
    const endMs = parseKugouTime(endText)
    checked++

    if (Number.isNaN(endMs)) {
      console.log(`[vip-covered] ${label} 没有可用的 SVIP 到期时间 → 需要签到`)
      needCheckin = true
      continue
    }
    if (endMs >= horizon) {
      console.log(`[vip-covered] ${label} SVIP 至 ${endText}，已覆盖到 ${horizonText} → 今日已领，跳过`)
    } else {
      console.log(`[vip-covered] ${label} SVIP 至 ${endText}，未覆盖 ${horizonText} → 需要签到`)
      needCheckin = true
    }
  }
} catch (e) {
  console.error('[vip-covered] 预检异常：' + e.message)
  needCheckin = true
} finally {
  try { close_api(api) } catch {}
}

if (checked === 0) needCheckin = true
process.exit(needCheckin ? 1 : 0)
