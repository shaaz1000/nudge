export type Cancel = () => void

export interface Clock {
  now(): number
  schedule(delayMs: number, fn: () => void): Cancel
}

export class SystemClock implements Clock {
  now(): number { return Date.now() }
  schedule(delayMs: number, fn: () => void): Cancel {
    const t = setTimeout(fn, delayMs)
    if (typeof t.unref === 'function') t.unref()
    return () => clearTimeout(t)
  }
}

interface Task { at: number; fn: () => void; cancelled: boolean }

export class FakeClock implements Clock {
  #now: number
  #tasks: Task[] = []

  constructor(start = 0) { this.#now = start }

  now(): number { return this.#now }

  schedule(delayMs: number, fn: () => void): Cancel {
    const task: Task = { at: this.#now + delayMs, fn, cancelled: false }
    this.#tasks.push(task)
    return () => {
      task.cancelled = true
      this.#tasks = this.#tasks.filter(t => t !== task)
    }
  }

  pendingCount(): number { return this.#tasks.filter(t => !t.cancelled).length }

  /**
   * Advance time, firing due tasks in deadline order. Tasks scheduled from
   * within a callback are picked up in the same advance if they come due,
   * which mirrors how real timers behave across a long tick.
   */
  advance(ms: number): void {
    const target = this.#now + ms
    for (;;) {
      const due = this.#tasks
        .filter(t => !t.cancelled && t.at <= target)
        .sort((a, b) => a.at - b.at)
      const next = due[0]
      if (!next) break
      this.#tasks = this.#tasks.filter(t => t !== next)
      this.#now = next.at
      next.fn()
    }
    this.#now = target
  }
}
