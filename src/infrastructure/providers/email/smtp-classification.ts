import type { SendResult } from '../../../contracts/provider-port.js';
import {
  PROVIDER_ERROR_CODES as CODES,
  UNKNOWN_REASONS,
  rejected,
  unknownOutcome,
} from '../send-results.js';

/**
 * Progress of a single SMTP session. `data` starts as soon as message bytes may have been
 * handed to the server (after the 354 reply to DATA): from then on a lost connection or a
 * timeout without an explicit reply is ambiguous.
 */
export type SmtpPhase = 'connect' | 'auth' | 'envelope' | 'data';

/** Subset of Nodemailer's error shape the classifier relies on. */
export interface SmtpErrorLike {
  code?: string | undefined;
  responseCode?: number | undefined;
  command?: string | undefined;
}

const AUTH_REPLY_CODES = new Set([530, 534, 535, 538]);

function rejectedByReply(command: string, responseCode: number): SendResult {
  if (AUTH_REPLY_CODES.has(responseCode)) {
    return rejected(
      'configuration',
      CODES.authenticationFailed,
      `SMTP server requires different authentication (reply ${responseCode})`,
    );
  }
  const temporary = responseCode < 500;
  const kind = temporary ? 'retryable' : 'permanent';
  if (command === 'MAIL FROM') {
    return rejected(
      kind,
      CODES.senderRejected,
      `SMTP server rejected the sender (reply ${responseCode})`,
    );
  }
  if (command === 'RCPT TO') {
    return rejected(
      kind,
      CODES.recipientRejected,
      `SMTP server rejected the recipient (reply ${responseCode})`,
    );
  }
  return rejected(
    kind,
    CODES.messageRejected,
    `SMTP server rejected the message (reply ${responseCode})`,
  );
}

const ENVELOPE_COMMANDS = new Set(['MAIL FROM', 'RCPT TO', 'DATA']);

/**
 * Maps a Nodemailer SMTP error to a SendResult. Conservative by design: once message data
 * may have reached the server, only an explicit 4xx/5xx reply counts as a certain rejection.
 */
export function classifySmtpError(error: SmtpErrorLike, phase: SmtpPhase): SendResult {
  const { code, responseCode, command } = error;

  if (
    responseCode !== undefined &&
    responseCode >= 400 &&
    responseCode < 600 &&
    command !== undefined &&
    ENVELOPE_COMMANDS.has(command)
  ) {
    return rejectedByReply(command, responseCode);
  }

  if (code === 'EAUTH' || code === 'ENOAUTH' || code === 'EOAUTH2') {
    return rejected('configuration', CODES.authenticationFailed, 'SMTP authentication failed');
  }
  if (code === 'EREQUIRETLS' || code === 'ECONFIG') {
    return rejected(
      'configuration',
      CODES.configurationInvalid,
      'SMTP server does not support the configured security requirements',
    );
  }

  if (phase === 'data') {
    if (code === 'ETIMEDOUT') return unknownOutcome(UNKNOWN_REASONS.timeoutAfterSubmission);
    if (code === 'EPROTOCOL') return unknownOutcome(UNKNOWN_REASONS.unparsableResponse);
    return unknownOutcome(UNKNOWN_REASONS.connectionLostAfterSubmission);
  }

  // Nothing of the message has been transmitted yet: the server cannot have accepted it.
  if (code === 'EENVELOPE' || code === 'EMESSAGE' || code === 'ESTREAM') {
    return rejected('permanent', CODES.invalidRequest, 'Message could not be submitted over SMTP');
  }
  if (code === 'ETLS') {
    return rejected('retryable', CODES.tlsFailed, 'SMTP TLS negotiation failed');
  }
  if (code === 'ETIMEDOUT') {
    return rejected('retryable', CODES.timeout, 'SMTP server did not respond before submission');
  }
  if (responseCode !== undefined && responseCode >= 500 && responseCode < 600) {
    return rejected(
      'configuration',
      CODES.connectionFailed,
      `SMTP server refused the session (reply ${responseCode})`,
    );
  }
  return rejected('retryable', CODES.connectionFailed, 'SMTP connection failed before submission');
}
