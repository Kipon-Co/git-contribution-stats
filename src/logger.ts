import { time } from 'console'
import { Signale } from 'signale'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface LoggerConfig {
  level: LogLevel
  scope: string[]
  disabled: boolean
  interactive: boolean
  timers: boolean
}

export class Logger {
  private logger: any
  private config: LoggerConfig = {
    level: 'info',
    scope: [],
    disabled: false,
    interactive: false,
    timers: true
  }

  private readonly logLevels = {
    debug: 0,
    info: 1,
    warn: 2,
    error: 3
  }

  constructor(config?: Partial<LoggerConfig>) {
    this.config = { ...this.config, ...config }
    
    const options = {
      scope: this.config.scope.join(', '),
      disabled: this.config.disabled,
      interactive: this.config.interactive,
      // timers property removed as it is not compatible
      types: {
        success: {
          badge: '',
          color: 'green',
          label: 'success'
        },
        log: {
          badge: '',
          color: 'blue',
          label: 'log'
        },
        debug: {
          badge: '',
          color: 'magenta',
          label: 'debug'
        },
        info: {
          badge: '',
          color: 'cyan',
          label: 'info'
        },
        warn: {
          badge: '',
          color: 'yellow',
          label: 'warn'
        },
        error: {
          badge: '',
          color: 'red',
          label: 'error'
        },
        pending: {
          badge: '',
          color: 'blue',
          label: 'pending'
        },
        complete: {
          badge: '',
          color: 'green',
          label: 'complete'
        },
        start: {
          badge: '',
          color: 'magenta',
          label: 'start'
        },
        pause: {
          badge: '',
          color: 'yellow',
          label: 'pause'
        },
        note: {
          badge: '',
          color: 'blue',
          label: 'note'
        },
        time: {
          badge: '',
          color: 'blue',
          label: 'time'
        },
        timeEnd: {
          badge: '',
          color: 'blue',
          label: 'timeEnd'
        },
        group: {
          badge: '',
          color: 'blue',
          label: 'group'
        },
      }
    }
    
    this.logger = new Signale({ ...options })
  }

  debug(message: any, ...args: any[]): void {
    if (this.logLevels['debug'] >= this.logLevels[this.config.level]) {
      this.logger.debug(message, ...args)
    }
  }

  info(message: any, ...args: any[]): void {
    if (this.logLevels['info'] >= this.logLevels[this.config.level]) {
      this.logger.info(message, ...args)
    }
  }

  warn(message: any, ...args: any[]): void {
    if (this.logLevels['warn'] >= this.logLevels[this.config.level]) {
      this.logger.warn(message, ...args)
    }
  }

  error(message: any, ...args: any[]): void {
    if (this.logLevels['error'] >= this.logLevels[this.config.level]) {
      this.logger.error(message, ...args)
    }
  }

  success(message: any, ...args: any[]): void {
    this.logger.success(message, ...args)
  }

  pending(message: any, ...args: any[]): void {
    this.logger.pending(message, ...args)
  }

  complete(message: any, ...args: any[]): void {
    this.logger.complete(message, ...args)
  }

  start(message: any, ...args: any[]): void {
    this.logger.start(message, ...args)
  }

  pause(message: any, ...args: any[]): void {
    this.logger.pause(message, ...args)
  }

  note(message: any, ...args: any[]): void {
    this.logger.note(message, ...args)
  }


  time(label: string): void {
    if (this.config.timers) {
      this.logger.time(console.time(label))
    }
  }

  timeEnd(label: string): void {
    if (this.config.timers) {
      this.logger.timeEnd(label)
    }
  }

  group(label: string): void {
    this.logger.group(label)
  }

  groupEnd(): void {
    this.logger.groupEnd()
  }
}