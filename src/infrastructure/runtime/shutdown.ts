import type { Logger } from 'pino';

type Closer = () => Promise<void>;
type Exit = (code: number) => void;

/**
 * Runs closers in registration order on SIGTERM/SIGINT, bounded by the grace period: exit 0 when
 * every closer finished in time (errors are logged), exit 1 when the grace period is exceeded.
 * Also installs the fatal handlers (see installFatalHandlers).
 */
export function installShutdown(
  logger: Logger,
  graceMs: number,
  closers: Closer[],
  exit: Exit = (code) => process.exit(code),
): void {
  installFatalHandlers(logger, exit);
  let shuttingDown = false;
  const handler = (signal: NodeJS.Signals) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal, graceMs }, 'shutdown started');
    const timer = setTimeout(() => {
      logger.error({ graceMs }, 'shutdown grace period exceeded');
      exit(1);
    }, graceMs);
    timer.unref();
    void (async () => {
      for (const close of closers) {
        try {
          await close();
        } catch (err) {
          logger.error({ err }, 'error during shutdown');
        }
      }
      clearTimeout(timer);
      logger.info('shutdown completed');
      exit(0);
    })();
  };
  process.once('SIGTERM', handler);
  process.once('SIGINT', handler);
}

let fatalHandlersInstalled = false;

/**
 * An unhandled rejection or uncaught exception leaves the process in an unknown state: log it as
 * fatal and exit 1 at once, without running closers. The restart policy brings the process back;
 * work in flight is recovered by leases and reconciliation (a `sending` delivery becomes `unknown`).
 */
export function installFatalHandlers(
  logger: Logger,
  exit: Exit = (code) => process.exit(code),
): void {
  if (fatalHandlersInstalled) return;
  fatalHandlersInstalled = true;
  process.on('uncaughtException', (err, origin) => {
    logger.fatal({ err, origin }, 'uncaught exception, exiting');
    exit(1);
  });
  process.on('unhandledRejection', (reason) => {
    logger.fatal({ err: reason }, 'unhandled promise rejection, exiting');
    exit(1);
  });
}
