// The batch's sense of "now", injected rather than read from the system.
//
// Two stages depend on it and both would otherwise be unreproducible: urgency
// (§4.2) is a function of hours until the subscription halts, and the contact
// window check (§4.4) is a function of the hour in IST. Reading `Date.now()`
// in either would mean the demo produced different numbers every run, and the
// 09:00–21:00 contact rule could not be tested at all.
import type { Clock } from './tool-types'

/** Frozen clock. The default for batch runs, so output is reproducible. */
export function fixedClock(at: number | string): Clock {
  const ms = typeof at === 'string' ? Date.parse(at) : at
  return { now: () => new Date(ms) }
}

export const systemClock: Clock = { now: () => new Date() }

export function hoursUntil(iso: string, now: Date): number {
  return (Date.parse(iso) - now.getTime()) / 3_600_000
}

/** The hour of day in IST (UTC+5:30), for the contact-window rule. */
export function istHour(now: Date): number {
  return new Date(now.getTime() + 5.5 * 3_600_000).getUTCHours()
}
