import { E2E_ENV } from './env.js';

/** Minimal client for the Mailpit HTTP API (shared local instance: always filter by recipient). */
export interface MailpitAddress {
  Name: string;
  Address: string;
}

export interface MailpitSummary {
  ID: string;
  MessageID: string;
  Subject: string;
  From: MailpitAddress;
  To: MailpitAddress[];
  Created: string;
}

export interface MailpitMessage extends MailpitSummary {
  Text: string;
  HTML: string;
}

interface SearchResponse {
  total: number;
  messages: MailpitSummary[];
}

export class Mailpit {
  constructor(private readonly baseUrl: string = E2E_ENV.mailpitApiUrl) {}

  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    const response = await fetch(`${this.baseUrl}${path}`, init);
    if (!response.ok) throw new Error(`Mailpit ${path} answered ${String(response.status)}`);
    return response;
  }

  async ping(): Promise<void> {
    await this.request('/messages?limit=1');
  }

  async search(query: string): Promise<MailpitSummary[]> {
    const response = await this.request(`/search?limit=200&query=${encodeURIComponent(query)}`);
    return ((await response.json()) as SearchResponse).messages;
  }

  /** Messages whose recipient list contains exactly `address`. */
  async byRecipient(address: string): Promise<MailpitSummary[]> {
    const messages = await this.search(`to:"${address}"`);
    const wanted = address.toLowerCase();
    return messages.filter((m) => m.To.some((to) => to.Address.toLowerCase() === wanted));
  }

  async message(id: string): Promise<MailpitMessage> {
    const response = await this.request(`/message/${encodeURIComponent(id)}`);
    return (await response.json()) as MailpitMessage;
  }

  async deleteByRecipient(address: string): Promise<void> {
    await this.request(`/search?query=${encodeURIComponent(`to:"${address}"`)}`, {
      method: 'DELETE',
    });
  }
}
