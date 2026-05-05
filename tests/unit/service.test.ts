// SPDX-License-Identifier: Apache-2.0

import { OpenSalesTaxProvider } from '../../src/providers/opensalestax/service';
import type { ItemTaxCalculationLine, TaxCalculationContext } from '@medusajs/framework/types';

const fakeLogger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
} as unknown as Parameters<typeof OpenSalesTaxProvider.prototype['constructor']>[0]['logger'];

const baseContext = (): TaxCalculationContext => ({
  address: {
    country_code: 'US',
    province_code: 'mn',
    postal_code: '55401',
    city: 'Minneapolis',
  },
});

const baseItemLine = (overrides: Partial<{ id: string; price: number; qty: number; productTypeId?: string; currency?: string }> = {}): ItemTaxCalculationLine => {
  const id = overrides.id ?? 'li_1';
  const price = overrides.price ?? 100;
  const qty = overrides.qty ?? 1;
  return {
    line_item: {
      id,
      product_id: 'p_1',
      product_type_id: overrides.productTypeId,
      quantity: qty,
      unit_price: price,
      currency_code: overrides.currency ?? 'usd',
    } as ItemTaxCalculationLine['line_item'],
    rates: [],
  };
};

// Stub the global fetch — Medusa providers run on Node 20+ where fetch is built in.
const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
  jest.clearAllMocks();
});

const stubFetchOk = (responseBody: unknown): jest.Mock => {
  const fn = jest.fn(async () =>
    new Response(JSON.stringify(responseBody), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }),
  );
  global.fetch = fn as unknown as typeof fetch;
  return fn;
};

const stubFetchStatus = (status: number, body = ''): jest.Mock => {
  const fn = jest.fn(async () =>
    new Response(body, { status, headers: { 'Content-Type': 'text/plain' } }),
  );
  global.fetch = fn as unknown as typeof fetch;
  return fn;
};

const stubFetchThrows = (err: Error): jest.Mock => {
  const fn = jest.fn(async () => {
    throw err;
  });
  global.fetch = fn as unknown as typeof fetch;
  return fn;
};

const SAMPLE_RESPONSE = {
  subtotal: '100.00',
  tax_total: '9.025',
  disclaimer: 'Calculation only',
  lines: [
    {
      amount: '100.00',
      category: 'general',
      tax: '9.0250',
      rate_pct: '9.025',
      jurisdictions: [
        { type: 'state', name: 'Minnesota', rate_pct: '6.875', tax: '6.8750' },
        { type: 'county', name: 'Hennepin County', rate_pct: '0.150', tax: '0.1500' },
        { type: 'city', name: 'Minneapolis', rate_pct: '0.500', tax: '0.5000' },
      ],
    },
  ],
};

describe('OpenSalesTaxProvider', () => {
  describe('construction', () => {
    it('throws when apiBaseUrl is missing', () => {
      expect(
        () =>
          new OpenSalesTaxProvider({ logger: fakeLogger }, {
            apiBaseUrl: '',
          }),
      ).toThrow(/apiBaseUrl.*required/);
    });

    it('exposes the static identifier via getIdentifier()', () => {
      const provider = new OpenSalesTaxProvider({ logger: fakeLogger }, { apiBaseUrl: 'http://stub' });
      expect(provider.getIdentifier()).toBe('opensalestax');
      expect(OpenSalesTaxProvider.identifier).toBe('opensalestax');
    });
  });

  describe('extractZip5', () => {
    it('returns the first 5 digits of a US ZIP', () => {
      expect(OpenSalesTaxProvider.extractZip5('55401')).toBe('55401');
      expect(OpenSalesTaxProvider.extractZip5('55401-1234')).toBe('55401');
      expect(OpenSalesTaxProvider.extractZip5('  55401  ')).toBe('55401');
    });

    it('returns null for invalid input', () => {
      expect(OpenSalesTaxProvider.extractZip5(null)).toBeNull();
      expect(OpenSalesTaxProvider.extractZip5(undefined)).toBeNull();
      expect(OpenSalesTaxProvider.extractZip5('')).toBeNull();
      expect(OpenSalesTaxProvider.extractZip5('123')).toBeNull(); // too short
      expect(OpenSalesTaxProvider.extractZip5('abc')).toBeNull(); // no digits
    });
  });

  describe('unitAmount', () => {
    it('multiplies unit_price by quantity', () => {
      const line = baseItemLine({ price: 25, qty: 3 });
      expect(OpenSalesTaxProvider.unitAmount(line)).toBe('75.00');
    });

    it('handles string-typed numerics', () => {
      const line = {
        line_item: { id: 'li_1', product_id: 'p_1', unit_price: '50.00', quantity: '2' },
        rates: [],
      } as unknown as ItemTaxCalculationLine;
      expect(OpenSalesTaxProvider.unitAmount(line)).toBe('100.00');
    });
  });

  describe('jurisdictionToTaxLine', () => {
    it('maps an engine jurisdiction to a Medusa ItemTaxLineDTO with correct percentage rate', () => {
      const line = OpenSalesTaxProvider.jurisdictionToTaxLine(
        { type: 'state', name: 'Minnesota', rate_pct: '6.875', tax: '6.8750' },
        'li_42',
      );

      expect(line.line_item_id).toBe('li_42');
      expect(line.provider_id).toBe('opensalestax');
      // Critical: rate must be a percentage (6.875), NOT a fraction (0.06875).
      expect(line.rate).toBe(6.875);
      expect(line.name).toBe('State: Minnesota');
      expect(line.code).toBe('OST-STATE-minnesota');
    });

    it('slugifies multi-word jurisdictions', () => {
      const line = OpenSalesTaxProvider.jurisdictionToTaxLine(
        { type: 'district', name: 'Hennepin County Transit Sales Tax', rate_pct: '0.500', tax: '0.5000' },
        'li_1',
      );
      expect(line.code).toBe('OST-DISTRICT-hennepin-county-transit-sales-tax');
    });
  });

  describe('getTaxLines', () => {
    it('returns one tax line per (item × jurisdiction) on the happy path', async () => {
      const fetchMock = stubFetchOk(SAMPLE_RESPONSE);
      const provider = new OpenSalesTaxProvider({ logger: fakeLogger }, { apiBaseUrl: 'http://stub' });

      const result = await provider.getTaxLines([baseItemLine()], [], baseContext());

      expect(fetchMock).toHaveBeenCalledTimes(1);
      // 1 item × 3 jurisdictions in SAMPLE_RESPONSE
      expect(result).toHaveLength(3);
      expect(result[0]).toMatchObject({
        line_item_id: 'li_1',
        provider_id: 'opensalestax',
        name: 'State: Minnesota',
        rate: 6.875,
      });
      expect(result.map((l) => 'line_item_id' in l ? l.line_item_id : null)).toEqual(['li_1', 'li_1', 'li_1']);
    });

    it('returns [] for non-US destinations without calling the engine', async () => {
      const fetchMock = stubFetchThrows(new Error('should not be called'));
      const provider = new OpenSalesTaxProvider({ logger: fakeLogger }, { apiBaseUrl: 'http://stub' });

      const ctx: TaxCalculationContext = {
        address: { country_code: 'CA', postal_code: 'M5V 3A8' },
      };

      const result = await provider.getTaxLines([baseItemLine()], [], ctx);

      expect(result).toEqual([]);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('returns [] for unparseable ZIP without calling the engine', async () => {
      const fetchMock = stubFetchThrows(new Error('should not be called'));
      const provider = new OpenSalesTaxProvider({ logger: fakeLogger }, { apiBaseUrl: 'http://stub' });

      const ctx: TaxCalculationContext = {
        address: { country_code: 'US', postal_code: 'abc' },
      };

      const result = await provider.getTaxLines([baseItemLine()], [], ctx);

      expect(result).toEqual([]);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('skips non-USD line items', async () => {
      const fetchMock = stubFetchOk(SAMPLE_RESPONSE);
      const provider = new OpenSalesTaxProvider({ logger: fakeLogger }, { apiBaseUrl: 'http://stub' });

      const result = await provider.getTaxLines(
        [
          baseItemLine({ id: 'li_usd', currency: 'usd' }),
          baseItemLine({ id: 'li_eur', currency: 'eur' }),
        ],
        [],
        baseContext(),
      );

      // Only the USD line is sent to the engine; the EUR line is dropped.
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const requestBody = JSON.parse((fetchMock.mock.calls[0]?.[1] as { body: string }).body);
      expect(requestBody.line_items).toHaveLength(1);
      // All resulting tax lines belong to li_usd.
      result.forEach((line) => {
        expect('line_item_id' in line ? line.line_item_id : null).toBe('li_usd');
      });
    });

    it('returns [] (fail-soft) when the engine returns 500', async () => {
      stubFetchStatus(500, 'engine error');
      const provider = new OpenSalesTaxProvider({ logger: fakeLogger }, { apiBaseUrl: 'http://stub' });

      const result = await provider.getTaxLines([baseItemLine()], [], baseContext());

      expect(result).toEqual([]);
      expect(fakeLogger?.error).toHaveBeenCalledWith(expect.stringContaining('calculate failed'));
    });

    it('returns [] (fail-soft) when fetch throws (network error)', async () => {
      stubFetchThrows(new Error('connection refused'));
      const provider = new OpenSalesTaxProvider({ logger: fakeLogger }, { apiBaseUrl: 'http://stub' });

      const result = await provider.getTaxLines([baseItemLine()], [], baseContext());

      expect(result).toEqual([]);
      expect(fakeLogger?.error).toHaveBeenCalledWith(expect.stringContaining('calculate failed'));
    });

    it('honors categoryByProductTypeId option to map product types to OST categories', async () => {
      const fetchMock = stubFetchOk(SAMPLE_RESPONSE);
      const provider = new OpenSalesTaxProvider(
        { logger: fakeLogger },
        {
          apiBaseUrl: 'http://stub',
          categoryByProductTypeId: {
            ptyp_clothing: 'clothing',
            ptyp_giftcards: '', // non-taxable
          },
        },
      );

      await provider.getTaxLines(
        [
          baseItemLine({ id: 'li_clothing', productTypeId: 'ptyp_clothing' }),
          baseItemLine({ id: 'li_gift', productTypeId: 'ptyp_giftcards' }), // skip
          baseItemLine({ id: 'li_other', productTypeId: 'ptyp_other' }), // default → general
        ],
        [],
        baseContext(),
      );

      const body = JSON.parse((fetchMock.mock.calls[0]?.[1] as { body: string }).body);
      // li_gift is excluded entirely; li_clothing and li_other go through.
      expect(body.line_items).toHaveLength(2);
      expect(body.line_items[0].category).toBe('clothing');
      expect(body.line_items[1].category).toBe('general');
    });

    it('returns [] when all lines are non-taxable', async () => {
      const fetchMock = stubFetchThrows(new Error('should not be called'));
      const provider = new OpenSalesTaxProvider(
        { logger: fakeLogger },
        {
          apiBaseUrl: 'http://stub',
          categoryByProductTypeId: { ptyp_giftcards: '' },
        },
      );

      const result = await provider.getTaxLines(
        [baseItemLine({ id: 'li_gift', productTypeId: 'ptyp_giftcards' })],
        [],
        baseContext(),
      );

      expect(result).toEqual([]);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('falls back to defaultCategory when product_type_id is unmapped', async () => {
      const fetchMock = stubFetchOk(SAMPLE_RESPONSE);
      const provider = new OpenSalesTaxProvider(
        { logger: fakeLogger },
        {
          apiBaseUrl: 'http://stub',
          defaultCategory: 'digital_goods',
        },
      );

      await provider.getTaxLines([baseItemLine({ id: 'li_x', productTypeId: 'ptyp_unmapped' })], [], baseContext());

      const body = JSON.parse((fetchMock.mock.calls[0]?.[1] as { body: string }).body);
      expect(body.line_items[0].category).toBe('digital_goods');
    });
  });
});
