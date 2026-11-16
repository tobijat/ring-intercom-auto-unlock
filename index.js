/**
 * ring-intercom-auto-unlock
 *
 * Automatically unlocks your door or gate when someone rings your Ring
 * Intercom, after a random human-like delay and only within a configurable
 * schedule (days, hours, timezone).
 *
 * Author:  Mattia Zatelli <zatellimattia@gmail.com>
 * License: MIT — https://github.com/mzat-dev/ring-intercom-auto-unlock
 *
 * Unofficial project, not affiliated with Ring LLC or Amazon.
 */

import 'dotenv/config'
import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { RingApi } from 'ring-client-api'

const APP_DIR = dirname(fileURLToPath(import.meta.url))
const ENV_PATH = join(APP_DIR, '.env')
const DEVICES_PATH = join(APP_DIR, 'devices.json')
const LOG_FILE_PATH = join(APP_DIR, 'auto-unlock.log')

// info (default) | debug — debug also enables ring-client-api internal logs
const LOG_LEVEL = process.env.LOG_LEVEL ?? 'info'
// how often (minutes) to log that the service is alive (0 = disabled)
const HEARTBEAT_MINUTES = Number(process.env.HEARTBEAT_MINUTES ?? 60)
// keep file logs for N days (0 = file logging off). Newest lines at the top of auto-unlock.log
const LOG_FILE_DAYS = Number(process.env.LOG_FILE ?? 0)
if (!Number.isInteger(LOG_FILE_DAYS) || LOG_FILE_DAYS < 0) {
  console.error(`Invalid LOG_FILE: "${process.env.LOG_FILE}". Expected 0 (off) or a positive number of days.`)
  process.exit(1)
}

const MS_PER_DAY = 24 * 60 * 60 * 1000
let logFileQueue = Promise.resolve()

function formatLogArgs(args) {
  return args
    .map((arg) => {
      if (typeof arg === 'string') return arg
      if (arg instanceof Error) return arg.stack || arg.message
      try {
        return JSON.stringify(arg)
      } catch {
        return String(arg)
      }
    })
    .join(' ')
}

function lineTimestampMs(line) {
  const match = line.match(/^(\d{4}-\d{2}-\d{2}T[\d:.]+Z)/)
  return match ? Date.parse(match[1]) : NaN
}

function writeLogFile(line) {
  if (LOG_FILE_DAYS === 0) return
  logFileQueue = logFileQueue
    .then(async () => {
      const cutoff = Date.now() - LOG_FILE_DAYS * MS_PER_DAY
      let existing = ''
      try {
        existing = await readFile(LOG_FILE_PATH, 'utf8')
      } catch (e) {
        if (e.code !== 'ENOENT') throw e
      }
      const kept = existing
        .split(/\r?\n/)
        .filter((entry) => entry.length > 0)
        .filter((entry) => {
          const ts = lineTimestampMs(entry)
          return Number.isNaN(ts) || ts >= cutoff
        })
      await writeFile(LOG_FILE_PATH, [line, ...kept].join('\n') + '\n')
    })
    .catch((e) => {
      console.error(new Date().toISOString(), '[error]', 'Failed to write auto-unlock.log:', e.message)
    })
}

const WEEKDAYS = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 }

function parseDays(value) {
  const trimmed = String(value ?? '').trim()
  if (!trimmed) return []
  return trimmed.split(',').map((part) => Number(part.trim()))
}

function parseHours(value) {
  const trimmed = String(value ?? '').trim()
  if (!trimmed) return []
  return trimmed.split(',').map((range) => {
    const [start, end] = range.trim().split('-').map(Number)
    return { start, end }
  })
}

function validateHours(hours, label) {
  if (hours.some(({ start, end }) => !Number.isInteger(start) || !Number.isInteger(end) || start >= end)) {
    console.error(`Invalid ${label}. Expected e.g. "8-20" or "8-12,13-20"`)
    process.exit(1)
  }
}

function formatHours(hours) {
  return hours.map(({ start, end }) => `${start}:00-${end}:00`).join(', ')
}

function localTime(timezone, date = new Date()) {
  return date.toLocaleString('en-GB', { timeZone: timezone })
}

// Convert a wall-clock time in `timezone` to a UTC epoch ms (handles DST).
function zonedLocalToUtcMs(timezone, year, month, day, hour, minute) {
  const utcGuess = Date.UTC(year, month - 1, day, hour, minute, 0)
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  })
  const offsetFor = (date) => {
    const parts = Object.fromEntries(
      dtf
        .formatToParts(date)
        .filter((part) => part.type !== 'literal')
        .map((part) => [part.type, part.value]),
    )
    const asUtc = Date.UTC(
      Number(parts.year),
      Number(parts.month) - 1,
      Number(parts.day),
      Number(parts.hour),
      Number(parts.minute),
      Number(parts.second),
    )
    return asUtc - date.getTime()
  }
  const once = new Date(utcGuess - offsetFor(new Date(utcGuess)))
  return utcGuess - offsetFor(once)
}

const WINDOW_TIME_RE = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})$/

function parseWindowInstant(value, timezone, label, field) {
  const match = String(value).trim().match(WINDOW_TIME_RE)
  if (!match) {
    console.error(
      `${label}: window "${field}" must look like "2026-11-16 18:52" (got ${JSON.stringify(value)})`,
    )
    process.exit(1)
  }
  const [, y, mo, d, h, mi] = match.map(Number)
  return zonedLocalToUtcMs(timezone, y, mo, d, h, mi)
}

function parseActiveWindows(activeWindows, timezone, label) {
  if (activeWindows == null) return []
  if (!Array.isArray(activeWindows)) {
    console.error(`${label}: "activeWindows" must be an array`)
    process.exit(1)
  }
  return activeWindows.map((window, index) => {
    if (!window || typeof window !== 'object') {
      console.error(`${label}: activeWindows[${index}] must be an object with start/end`)
      process.exit(1)
    }
    const startMs = parseWindowInstant(window.start, timezone, label, 'start')
    const endMs = parseWindowInstant(window.end, timezone, label, 'end')
    if (!(startMs < endMs)) {
      console.error(`${label}: activeWindows[${index}] start must be before end`)
      process.exit(1)
    }
    return {
      startMs,
      endMs,
      start: String(window.start).trim(),
      end: String(window.end).trim(),
    }
  })
}

function isWithinWeeklySchedule(schedule, date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: schedule.timezone,
    weekday: 'short',
    hour: 'numeric',
    hourCycle: 'h23',
  }).formatToParts(date)
  const weekday = WEEKDAYS[parts.find((p) => p.type === 'weekday').value]
  const hour = Number(parts.find((p) => p.type === 'hour').value)
  return (
    schedule.days.includes(weekday) &&
    schedule.hours.some(({ start, end }) => hour >= start && hour < end)
  )
}

function isWithinCustomWindow(schedule, date = new Date()) {
  const now = date.getTime()
  // start inclusive, end exclusive — same convention as activeHours
  return schedule.activeWindows.some(({ startMs, endMs }) => now >= startMs && now < endMs)
}

// Weekly schedule OR any custom window (activeWindows force ON even outside activeDays/hours)
function isWithinSchedule(schedule, date = new Date()) {
  return isWithinWeeklySchedule(schedule, date) || isWithinCustomWindow(schedule, date)
}

function requireNumber(entry, key, label) {
  const value = Number(entry[key])
  if (!Number.isFinite(value) || value < 0) {
    console.error(`devices.json entry ${label}: "${key}" must be a number >= 0`)
    process.exit(1)
  }
  return value
}

function timingFromValues(minDelay, maxDelay, cooldown, label) {
  if (minDelay > maxDelay) {
    console.error(`${label}: minDelaySeconds (${minDelay}) must be <= maxDelaySeconds (${maxDelay})`)
    process.exit(1)
  }
  return { minDelay, maxDelay, cooldown }
}

function scheduleFromDevice(entry) {
  const label = entry.name ? `"${entry.name}" (id ${entry.id})` : `id ${entry.id}`
  if (entry.timezone == null || entry.timezone === '') {
    console.error(`devices.json entry ${label} is missing required "timezone"`)
    process.exit(1)
  }
  if (entry.activeDays == null) {
    console.error(`devices.json entry ${label} is missing "activeDays" (use "" to disable the weekly day filter)`)
    process.exit(1)
  }
  if (entry.activeHours == null) {
    console.error(`devices.json entry ${label} is missing "activeHours" (use "" to disable the weekly hour filter)`)
    process.exit(1)
  }
  const days = parseDays(entry.activeDays)
  const hours = parseHours(entry.activeHours)
  const timezone = String(entry.timezone)
  if (hours.length > 0) {
    validateHours(hours, `activeHours for ${label}`)
  }
  if (days.some((day) => !Number.isInteger(day) || day < 1 || day > 7)) {
    console.error(`Invalid activeDays for ${label}: "${entry.activeDays}"`)
    process.exit(1)
  }
  const activeWindows = parseActiveWindows(entry.activeWindows, timezone, label)
  return { days, hours, timezone, activeWindows }
}

function timingFromDevice(entry) {
  const label = entry.name ? `"${entry.name}" (id ${entry.id})` : `id ${entry.id}`
  for (const key of ['minDelaySeconds', 'maxDelaySeconds', 'cooldownSeconds']) {
    if (entry[key] == null || entry[key] === '') {
      console.error(`devices.json entry ${label} is missing required "${key}"`)
      process.exit(1)
    }
  }
  return timingFromValues(
    requireNumber(entry, 'minDelaySeconds', label),
    requireNumber(entry, 'maxDelaySeconds', label),
    requireNumber(entry, 'cooldownSeconds', label),
    label,
  )
}

async function loadDeviceConfigs() {
  let raw
  try {
    raw = await readFile(DEVICES_PATH, 'utf8')
  } catch (e) {
    if (e.code === 'ENOENT') {
      console.error(
        'devices.json is required. Copy devices.json.example to devices.json and set your intercom ids.',
      )
      process.exit(1)
    }
    throw e
  }

  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (e) {
    console.error(`Invalid JSON in devices.json: ${e.message}`)
    process.exit(1)
  }

  if (!Array.isArray(parsed) || parsed.length === 0) {
    console.error('devices.json must be a non-empty array of device objects')
    process.exit(1)
  }

  const byId = new Map()
  for (const entry of parsed) {
    const id = Number(entry.id)
    if (!Number.isInteger(id)) {
      console.error(`Each devices.json entry needs a numeric "id" (got ${JSON.stringify(entry.id)})`)
      process.exit(1)
    }
    if (byId.has(id)) {
      console.error(`Duplicate device id in devices.json: ${id}`)
      process.exit(1)
    }
    if (entry.enabled != null && typeof entry.enabled !== 'boolean') {
      console.error(`devices.json entry id ${id}: "enabled" must be true or false`)
      process.exit(1)
    }
    byId.set(id, {
      id,
      name: entry.name != null ? String(entry.name) : null,
      enabled: entry.enabled !== false,
      schedule: scheduleFromDevice(entry),
      timing: timingFromDevice(entry),
    })
  }
  return byId
}

function deviceLabel(config, intercom) {
  if (config?.name) return `"${config.name}" (id ${config.id})`
  if (intercom) return `"${intercom.name}" (id ${intercom.id})`
  return `id ${config.id}`
}

const log = {
  write(level, args) {
    const iso = new Date().toISOString()
    console.log(iso, `[${level}]`, ...args)
    writeLogFile(`${iso} [${level}] ${formatLogArgs(args)}`)
  },
  debug(...args) {
    if (LOG_LEVEL === 'debug') this.write('debug', args)
  },
  info(...args) {
    this.write('info', args)
  },
  warn(...args) {
    this.write('warn', args)
  },
  error(...args) {
    this.write('error', args)
  },
}

if (!process.env.RING_REFRESH_TOKEN) {
  log.error(
    'RING_REFRESH_TOKEN is missing. Run "npx ring-auth-cli" to get a token,',
    'then save it in the .env file as RING_REFRESH_TOKEN=<token>',
  )
  process.exit(1)
}

const deviceConfigs = await loadDeviceConfigs()

log.info('Starting auto-unlock service')
log.info(`  node ${process.version}, log level: ${LOG_LEVEL}`)
if (LOG_FILE_DAYS > 0) {
  log.info(`  file logging: auto-unlock.log, keep ${LOG_FILE_DAYS} day(s), newest first`)
} else {
  log.info('  file logging: off (LOG_FILE=0)')
}
const enabledCount = [...deviceConfigs.values()].filter((d) => d.enabled).length
log.info(
  `  devices.json loaded (${deviceConfigs.size} listed, ${enabledCount} enabled)`,
)

const ringApi = new RingApi({
  refreshToken: process.env.RING_REFRESH_TOKEN,
  controlCenterDisplayName: 'ring-intercom-auto-unlock',
  debug: LOG_LEVEL === 'debug',
})

// Ring rotates refresh tokens: without persistence the service could not
// authenticate again after the next restart
ringApi.onRefreshTokenUpdated.subscribe(async ({ newRefreshToken, oldRefreshToken }) => {
  log.info('Refresh token rotated by Ring, saving the new token to .env')
  try {
    const env = await readFile(ENV_PATH, 'utf8')
    const updated = oldRefreshToken && env.includes(oldRefreshToken)
      ? env.replace(oldRefreshToken, newRefreshToken)
      : env.replace(/^RING_REFRESH_TOKEN=.*$/m, `RING_REFRESH_TOKEN=${newRefreshToken}`)
    await writeFile(ENV_PATH, updated)
    log.debug('New refresh token saved successfully')
  } catch (e) {
    log.error('Could not save the new refresh token:', e.message)
  }
})

log.debug('Connecting to Ring locations...')
const locations = await ringApi.getLocations()
log.info(`Locations found: ${locations.map((l) => `"${l.name}"`).join(', ')}`)

const allIntercoms = locations.flatMap((location) => location.intercoms)

if (allIntercoms.length === 0) {
  log.error('No Ring Intercom found on this account.')
  process.exit(1)
}

for (const intercom of allIntercoms) {
  log.info(
    `Intercom found: "${intercom.name}" (id ${intercom.id}, type ${intercom.deviceType}, ` +
      `battery ${intercom.batteryLevel}%${intercom.isOffline ? ', OFFLINE' : ''})`,
  )
}

const intercoms = []
const matchedIds = new Set()
for (const intercom of allIntercoms) {
  const config = deviceConfigs.get(Number(intercom.id))
  if (!config) {
    log.info(`  -> skipping "${intercom.name}" (id ${intercom.id}): not listed in devices.json`)
    continue
  }
  matchedIds.add(config.id)
  if (!config.enabled) {
    log.info(`  -> skipping ${deviceLabel(config, intercom)}: enabled=false`)
    continue
  }
  intercom._schedule = config.schedule
  intercom._timing = config.timing
  intercom._configName = config.name
  intercoms.push(intercom)
}
for (const config of deviceConfigs.values()) {
  if (!matchedIds.has(config.id)) {
    log.warn(
      `devices.json lists ${deviceLabel(config)}, but no matching intercom was found on this account`,
    )
  }
}
if (intercoms.length === 0) {
  log.error(
    'No enabled devices from devices.json matched an intercom on this account. Check ids and enabled flags.',
  )
  process.exit(1)
}

for (const intercom of intercoms) {
  const schedule = intercom._schedule
  const timing = intercom._timing
  const label = intercom._configName
    ? `"${intercom._configName}" / Ring "${intercom.name}" (id ${intercom.id})`
    : `"${intercom.name}" (id ${intercom.id})`
  const viaWeekly = isWithinWeeklySchedule(schedule)
  const viaCustom = isWithinCustomWindow(schedule)
  const activeReason = viaCustom ? 'activeWindows' : viaWeekly ? 'weekly schedule' : 'none'
  const hasWeekly = schedule.days.length > 0 && schedule.hours.length > 0
  if (!hasWeekly && schedule.activeWindows.length === 0) {
    log.warn(
      `${label}: no active schedule (empty activeDays/activeHours and no activeWindows) — dings will be ignored until you add one`,
    )
  }
  log.info(
    `Enrolling ${label}: days [${schedule.days.length ? schedule.days.join(',') : 'none'}], ` +
      `hours ${schedule.hours.length ? formatHours(schedule.hours) : 'none'} (${schedule.timezone}), ` +
      `activeWindows ${schedule.activeWindows.length}, ` +
      `delay ${timing.minDelay}-${timing.maxDelay}s, cooldown ${timing.cooldown}s — ` +
      `now ${localTime(schedule.timezone)}, ` +
      `${isWithinSchedule(schedule) ? 'ACTIVE' : 'NOT active'} (${activeReason})`,
  )

  // track device state changes (battery, connectivity)
  let lastBattery = intercom.batteryLevel
  let lastOffline = intercom.isOffline
  intercom.onData.subscribe(() => {
    if (intercom.isOffline !== lastOffline) {
      lastOffline = intercom.isOffline
      if (intercom.isOffline) {
        log.warn(`"${intercom.name}" is OFFLINE`)
      } else {
        log.info(`"${intercom.name}" is back online`)
      }
    }
    if (intercom.batteryLevel !== lastBattery) {
      log.debug(`"${intercom.name}" battery: ${lastBattery}% -> ${intercom.batteryLevel}%`)
      lastBattery = intercom.batteryLevel
      if (intercom.batteryLevel !== null && intercom.batteryLevel <= 20) {
        log.warn(`"${intercom.name}" battery low: ${intercom.batteryLevel}%`)
      }
    }
  })

  let busyUntil = 0

  intercom.onDing.subscribe(() => {
    log.info(`DING received from "${intercom.name}" (at ${localTime(schedule.timezone)})`)

    if (!isWithinSchedule(schedule)) {
      log.info('  -> ignored: outside the auto-unlock time window')
      return
    }
    const now = Date.now()
    if (now < busyUntil) {
      const secondsLeft = Math.ceil((busyUntil - now) / 1000)
      log.info(`  -> ignored: unlock already in progress or cooling down (${secondsLeft}s left)`)
      return
    }

    const delaySeconds =
      timing.minDelay + Math.random() * (timing.maxDelay - timing.minDelay)
    busyUntil = now + (delaySeconds + timing.cooldown) * 1000
    const openAt = new Date(now + delaySeconds * 1000)
    log.info(
      `  -> unlock scheduled in ${delaySeconds.toFixed(1)}s (at ${localTime(schedule.timezone, openAt)})`,
    )

    setTimeout(async () => {
      if (!isWithinSchedule(schedule)) {
        busyUntil = 0
        log.warn(`Unlock cancelled ("${intercom.name}"): closing time reached`)
        return
      }
      log.info(`Sending unlock command to "${intercom.name}"...`)
      const started = Date.now()
      try {
        await intercom.unlock()
        log.info(`GATE OPENED ("${intercom.name}", command succeeded in ${Date.now() - started}ms)`)
        log.debug(`  cooldown active for another ${timing.cooldown}s`)
      } catch (e) {
        busyUntil = 0
        log.error(`Failed to unlock ("${intercom.name}"):`, e.message)
        log.debug(e.stack)
      }
    }, delaySeconds * 1000)
  })

  intercom.onUnlocked.subscribe(() => {
    log.info(`Unlock confirmation received from "${intercom.name}"`)
  })

  intercom.onRequestUpdate.subscribe(() => {
    log.debug(`Data update requested for "${intercom.name}"`)
  })
}

if (HEARTBEAT_MINUTES > 0) {
  setInterval(() => {
    const status = intercoms
      .map((i) => {
        const schedule = i._schedule
        return (
          `"${i.name}": ${i.isOffline ? 'OFFLINE' : 'online'}, battery ${i.batteryLevel}%, ` +
          `window ${isWithinSchedule(schedule) ? 'ACTIVE' : 'not active'}`
        )
      })
      .join('; ')
    log.info(`Heartbeat — service alive (${status})`)
  }, HEARTBEAT_MINUTES * 60 * 1000)
}

log.info('Listening for dings...')

function shutdown(signal) {
  log.info(`Received ${signal}, shutting down`)
  ringApi.disconnect()
  process.exit(0)
}
process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))

process.on('unhandledRejection', (reason) => {
  log.error('Unhandled rejection:', reason?.message ?? reason)
  log.debug(reason?.stack)
})
