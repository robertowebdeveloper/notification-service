import type { AddressInfo } from 'node:net';
import { SMTPServer } from 'smtp-server';

/**
 * Local SMTP test double on an ephemeral loopback port. Behaviour is selected by the
 * recipient local part (e.g. `rcpt-550@example.test`), so no real destination is involved.
 */
export interface ReceivedSmtpMessage {
  from: string | undefined;
  to: string[];
  raw: string;
}

function smtpError(responseCode: number, message: string): Error {
  return Object.assign(new Error(message), { responseCode });
}

function localPart(address: string): string {
  return address.split('@')[0] ?? '';
}

export interface FakeSmtpServer {
  port: number;
  messages: ReceivedSmtpMessage[];
  connections: number;
  close(): Promise<void>;
}

export interface FakeSmtpOptions {
  /** When set, AUTH is required and only these credentials are accepted. */
  credentials?: { username: string; password: string };
}

export async function startFakeSmtpServer(options: FakeSmtpOptions = {}): Promise<FakeSmtpServer> {
  const state = { messages: [] as ReceivedSmtpMessage[], connections: 0 };
  const server = new SMTPServer({
    logger: false,
    disabledCommands: options.credentials ? ['STARTTLS'] : ['STARTTLS', 'AUTH'],
    authOptional: options.credentials === undefined,
    allowInsecureAuth: true,
    closeTimeout: 1_000,
    onConnect(_session, callback) {
      state.connections += 1;
      callback();
    },
    onAuth(auth, _session, callback) {
      const expected = options.credentials;
      if (expected && auth.username === expected.username && auth.password === expected.password) {
        callback(null, { user: auth.username ?? 'user' });
        return;
      }
      callback(smtpError(535, 'Authentication credentials invalid'));
    },
    onRcptTo(address, _session, callback) {
      const local = localPart(address.address);
      if (local === 'rcpt-550' || local === 'reject-permanent') {
        callback(smtpError(550, 'Mailbox unavailable'));
      } else if (local === 'rcpt-451' || local === 'reject-retryable') {
        callback(smtpError(451, 'Try again later'));
      } else {
        callback();
      }
    },
    onData(stream, session, callback) {
      const chunks: Buffer[] = [];
      stream.on('data', (chunk: Buffer) => chunks.push(chunk));
      stream.on('end', () => {
        const to = session.envelope.rcptTo.map((rcpt) => rcpt.address);
        const local = localPart(to[0] ?? '');
        if (local === 'hang') return; // never reply after the message body
        if (local === 'data-554') {
          callback(smtpError(554, 'Message rejected'));
          return;
        }
        if (local === 'data-451') {
          callback(smtpError(451, 'Temporary failure'));
          return;
        }
        state.messages.push({
          from: session.envelope.mailFrom === false ? undefined : session.envelope.mailFrom.address,
          to,
          raw: Buffer.concat(chunks).toString('utf8'),
        });
        callback(null, 'Queued');
      });
    },
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.server.address() as AddressInfo;

  return {
    port,
    get messages() {
      return state.messages;
    },
    get connections() {
      return state.connections;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.close(resolve);
      }),
  };
}

/** A loopback port with nothing listening on it (connection refused). */
export async function closedPort(): Promise<number> {
  const { createServer } = await import('node:net');
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((resolve) =>
    probe.close(() => {
      resolve();
    }),
  );
  return port;
}
