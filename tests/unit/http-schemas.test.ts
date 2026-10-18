import { describe, expect, it } from 'vitest';
import { Value } from 'typebox/value';
import { CreateNotificationBody } from '../../src/contracts/http-schemas.js';

const email = {
  channel: 'email',
  routingKey: 'transactional',
  recipient: { email: 'cliente@example.com' },
  content: { from: 'Ordini <ordini@example.com>', subject: 'Conferma', text: 'Ricevuto' },
};

describe('CreateNotificationBody', () => {
  it('accepts the documented email example', () => {
    expect(Value.Check(CreateNotificationBody, email)).toBe(true);
  });

  it('rejects unknown fields such as arbitrary headers', () => {
    expect(
      Value.Check(CreateNotificationBody, { ...email, content: { ...email.content, headers: {} } }),
    ).toBe(false);
  });

  it('represents future channels in the contract', () => {
    const sms = {
      channel: 'sms',
      routingKey: 'otp',
      recipient: { phoneNumber: '+393331234567' },
      content: { text: 'Codice 1234' },
    };
    expect(Value.Check(CreateNotificationBody, sms)).toBe(true);
  });
});
