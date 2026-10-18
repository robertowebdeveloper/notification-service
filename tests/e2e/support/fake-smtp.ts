import type { AddressInfo } from 'node:net';
import { SMTPServer } from 'smtp-server';

/**
 * Controllable SMTP provider double for the e2e suite (loopback, ephemeral port).
 *
 * Behaviour is programmed per recipient as a sequence consumed one SMTP transaction at a time
 * (the last entry repeats). Every transaction is recorded, so scenarios can assert exactly how
 * many times the service tried to send and how many messages may have been accepted.
 *
 * - accept:   250 after DATA.
 * - rcpt-451 / rcpt-550: certain rejection at RCPT TO (temporary / permanent).
 * - data-451 / data-554: full body received, then certain rejection.
 * - hang:     full body received, never answers (ambiguous: the provider may have accepted).
 * - hold:     full body received, answers 250 only when `release()` is called.
 */
export type SmtpBehaviour =
  'accept' | 'rcpt-451' | 'rcpt-550' | 'data-451' | 'data-554' | 'hang' | 'hold';

export interface SmtpTransaction {
  recipient: string;
  behaviour: SmtpBehaviour;
  rcptAt: Date;
  /** Set when the whole message body was received by the server. */
  dataAt?: Date;
  raw?: string;
  /** Final reply sent: 250, 451, 550, 554, or undefined while held/hanging. */
  reply?: number;
}

function smtpError(responseCode: number, message: string): Error {
  return Object.assign(new Error(message), { responseCode });
}

const AMBIGUOUS_OR_ACCEPTED: readonly SmtpBehaviour[] = ['accept', 'hang', 'hold'];

export interface FakeSmtpServer {
  readonly host: string;
  readonly port: number;
  readonly transactions: readonly SmtpTransaction[];
  program(recipient: string, behaviours: SmtpBehaviour[]): void;
  /** Number of RCPT TO for the recipient, i.e. send calls that reached the envelope. */
  sendAttempts(recipient: string): number;
  /** Bodies received whose reply was (or may still become) a 250: potential deliveries. */
  potentialDeliveries(recipient: string): number;
  /** Bodies answered with 250. */
  acceptedMessages(recipient: string): SmtpTransaction[];
  /** Answers every held transaction of the recipient with 250. Returns how many were held. */
  release(recipient: string): number;
  releaseAll(): void;
  close(): Promise<void>;
}

export async function startFakeSmtpServer(): Promise<FakeSmtpServer> {
  const programs = new Map<string, SmtpBehaviour[]>();
  const transactions: SmtpTransaction[] = [];
  const bySession = new Map<string, SmtpTransaction>();
  const held = new Map<string, (() => void)[]>();

  const next = (recipient: string): SmtpBehaviour => {
    const queue = programs.get(recipient);
    if (queue === undefined || queue.length === 0) return 'accept';
    return queue.length > 1 ? (queue.shift() ?? 'accept') : (queue[0] ?? 'accept');
  };

  const server = new SMTPServer({
    logger: false,
    disabledCommands: ['STARTTLS', 'AUTH'],
    authOptional: true,
    // Held transactions must survive long pauses (stopped workers, lease expiry scenarios).
    socketTimeout: 15 * 60_000,
    closeTimeout: 500,
    onRcptTo(address, session, callback) {
      const recipient = address.address.toLowerCase();
      const behaviour = next(recipient);
      const transaction: SmtpTransaction = { recipient, behaviour, rcptAt: new Date() };
      transactions.push(transaction);
      bySession.set(session.id, transaction);
      if (behaviour === 'rcpt-451') {
        transaction.reply = 451;
        callback(smtpError(451, 'Try again later'));
      } else if (behaviour === 'rcpt-550') {
        transaction.reply = 550;
        callback(smtpError(550, 'Mailbox unavailable'));
      } else {
        callback();
      }
    },
    onData(stream, session, callback) {
      const chunks: Buffer[] = [];
      stream.on('data', (chunk: Buffer) => chunks.push(chunk));
      stream.on('end', () => {
        const transaction = bySession.get(session.id);
        if (transaction === undefined) {
          callback(smtpError(554, 'No transaction'));
          return;
        }
        transaction.dataAt = new Date();
        transaction.raw = Buffer.concat(chunks).toString('utf8');
        switch (transaction.behaviour) {
          case 'hang':
            return;
          case 'hold': {
            const list = held.get(transaction.recipient) ?? [];
            list.push(() => {
              transaction.reply = 250;
              callback(null, 'Queued');
            });
            held.set(transaction.recipient, list);
            return;
          }
          case 'data-451':
            transaction.reply = 451;
            callback(smtpError(451, 'Temporary failure'));
            return;
          case 'data-554':
            transaction.reply = 554;
            callback(smtpError(554, 'Message rejected'));
            return;
          default:
            transaction.reply = 250;
            callback(null, 'Queued');
        }
      });
    },
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.server.address() as AddressInfo;

  const forRecipient = (recipient: string) =>
    transactions.filter((t) => t.recipient === recipient.toLowerCase());

  const release = (recipient: string): number => {
    const list = held.get(recipient.toLowerCase()) ?? [];
    held.delete(recipient.toLowerCase());
    for (const reply of list) reply();
    return list.length;
  };

  return {
    host: '127.0.0.1',
    port,
    transactions,
    program(recipient, behaviours) {
      programs.set(recipient.toLowerCase(), [...behaviours]);
    },
    sendAttempts: (recipient) => forRecipient(recipient).length,
    potentialDeliveries: (recipient) =>
      forRecipient(recipient).filter(
        (t) => t.dataAt !== undefined && AMBIGUOUS_OR_ACCEPTED.includes(t.behaviour),
      ).length,
    acceptedMessages: (recipient) => forRecipient(recipient).filter((t) => t.reply === 250),
    release,
    releaseAll() {
      for (const recipient of [...held.keys()]) release(recipient);
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.close(resolve);
      }),
  };
}
