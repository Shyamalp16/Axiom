import chalk from 'chalk';
import { format } from 'date-fns';

enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
  CRITICAL = 4,
}

const LOG_LEVEL = process.env.LOG_LEVEL 
  ? parseInt(process.env.LOG_LEVEL) 
  : LogLevel.INFO;

function timestamp(): string {
  return chalk.gray(format(new Date(), 'HH:mm:ss.SSS'));
}

export const logger = {
  debug(message: string, data?: unknown): void {
    if (LOG_LEVEL <= LogLevel.DEBUG) {
      console.log(`${timestamp()} ${chalk.gray('[DEBUG]')} ${message}`, data ?? '');
    }
  },

  info(message: string, data?: unknown): void {
    if (LOG_LEVEL <= LogLevel.INFO) {
      console.log(`${timestamp()} ${chalk.blue('[INFO]')} ${message}`, data ?? '');
    }
  },

  success(message: string, data?: unknown): void {
    if (LOG_LEVEL <= LogLevel.INFO) {
      console.log(`${timestamp()} ${chalk.green('[SUCCESS]')} ${message}`, data ?? '');
    }
  },

  warn(message: string, data?: unknown): void {
    if (LOG_LEVEL <= LogLevel.WARN) {
      console.log(`${timestamp()} ${chalk.yellow('[WARN]')} ${message}`, data ?? '');
    }
  },

  error(message: string, data?: unknown): void {
    if (LOG_LEVEL <= LogLevel.ERROR) {
      console.log(`${timestamp()} ${chalk.red('[ERROR]')} ${message}`, data ?? '');
    }
  },

  critical(message: string, data?: unknown): void {
    console.log(`${timestamp()} ${chalk.bgRed.white('[CRITICAL]')} ${message}`, data ?? '');
  },

  trade(action: 'BUY' | 'SELL', message: string, data?: unknown): void {
    const actionColor = action === 'BUY' ? chalk.green : chalk.red;
    console.log(`${timestamp()} ${actionColor(`[${action}]`)} ${message}`, data ?? '');
  },

  checklist(item: string, passed: boolean, detail?: string): void {
    const icon = passed ? chalk.green('✓') : chalk.red('✗');
    const text = passed ? chalk.green(item) : chalk.red(item);
    console.log(`  ${icon} ${text}${detail ? chalk.gray(` (${detail})`) : ''}`);
  },

  divider(): void {
    console.log(chalk.gray('─'.repeat(60)));
  },

  header(text: string): void {
    console.log('');
    console.log(chalk.bold.cyan(`═══ ${text} ═══`));
    console.log('');
  },

  box(title: string, content: string[]): void {
    const width = Math.max(title.length, ...content.map(c => c.length)) + 4;
    const border = '─'.repeat(width);
    
    console.log(chalk.gray(`┌${border}┐`));
    console.log(chalk.gray('│') + chalk.bold.white(` ${title.padEnd(width - 1)}`) + chalk.gray('│'));
    console.log(chalk.gray(`├${border}┤`));
    
    for (const line of content) {
      console.log(chalk.gray('│') + ` ${line.padEnd(width - 1)}` + chalk.gray('│'));
    }
    
    console.log(chalk.gray(`└${border}┘`));
  },

  alert(type: 'info' | 'warning' | 'danger', message: string): void {
    const colors = {
      info: chalk.bgBlue.white,
      warning: chalk.bgYellow.black,
      danger: chalk.bgRed.white,
    };
    console.log(`\n${colors[type](` ${message} `)}\n`);
  },
};

export default logger;
