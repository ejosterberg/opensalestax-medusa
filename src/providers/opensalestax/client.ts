// SPDX-License-Identifier: Apache-2.0

/**
 * Minimal HTTP client for the OpenSalesTax engine.
 *
 * Uses the global `fetch` available on Node 20+ — no axios / node-fetch
 * dependency. Keeps the published bundle small and dodges CJS/ESM
 * compatibility issues in `medusa plugin:build`'s SWC pipeline.
 */

export interface OpenSalesTaxClientOptions {
  baseUrl: string;
  apiKey?: string;
  /** Per-request timeout in milliseconds. Default 5000. */
  timeoutMs?: number;
}

export interface CalculateLineItem {
  amount: string; // pre-tax decimal string, e.g. "100.00"
  category: string; // one of OST's 6 categories or "" to skip
}

export interface CalculateRequest {
  address: { zip5: string };
  line_items: CalculateLineItem[];
}

export interface JurisdictionRate {
  type: string;
  name: string;
  rate_pct: string;
  tax: string | null;
}

export interface CalculatedLine {
  amount: string;
  category: string;
  tax: string;
  rate_pct: string;
  jurisdictions: JurisdictionRate[];
  note?: string | null;
}

export interface CalculateResponse {
  subtotal: string;
  tax_total: string;
  lines: CalculatedLine[];
  disclaimer?: string;
}

export class OpenSalesTaxApiError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'OpenSalesTaxApiError';
  }
}

export class OpenSalesTaxClient {
  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly timeoutMs: number;

  constructor(options: OpenSalesTaxClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.apiKey = options.apiKey;
    this.timeoutMs = options.timeoutMs ?? 5000;
  }

  async calculate(req: CalculateRequest): Promise<CalculateResponse> {
    return this.post<CalculateResponse>('/v1/calculate', req);
  }

  async health(): Promise<{ status: string; version: string; database_connected: boolean }> {
    return this.get<{ status: string; version: string; database_connected: boolean }>('/v1/health');
  }

  private async get<T>(path: string): Promise<T> {
    return this.request<T>('GET', path);
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>('POST', path, body);
  }

  private async request<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };
    if (this.apiKey !== undefined && this.apiKey !== '') {
      headers['X-API-Key'] = this.apiKey;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new OpenSalesTaxApiError(`Network error contacting OpenSalesTax engine at ${this.baseUrl}: ${message}`);
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new OpenSalesTaxApiError(
        `OpenSalesTax engine returned HTTP ${response.status}${text ? ': ' + text.slice(0, 200) : ''}`,
        response.status,
      );
    }

    try {
      return (await response.json()) as T;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new OpenSalesTaxApiError(`OpenSalesTax engine returned malformed JSON: ${message}`);
    }
  }
}
