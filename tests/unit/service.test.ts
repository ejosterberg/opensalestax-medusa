// SPDX-License-Identifier: Apache-2.0

import { OpenSalesTaxProvider } from '../../src/providers/opensalestax/service';
import type {
  ICacheService,
  ItemTaxCalculationLine,
  ShippingTaxCalculationLine,
  TaxCalculationContext,
} from '@medusajs/framework/types';

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

const baseShippingLine = (overrides: Partial<{ id: string; price: number; currency?: string }> = {}): ShippingTaxCalculationLine => {
  return {
    shipping_line: {
      id: overrides.id ?? 'sl_1',
      shipping_option_id: 'so_1',
      unit_price: overrides.price ?? 10,
      currency_code: overrides.currency ?? 'usd',
    } as ShippingTaxCalculationLine['shipping_line'],
    rates: [],
  };
};

/** A simple in-memory cache that tracks get/set call counts for assertions. */
const makeFakeCache = (): ICacheService & { _store: Map<string, unknown>; _gets: number; _sets: number } => {
  const store = new Map<string, unknown>();
  const cache = {
    _store: store,
    _gets: 0,
    _sets: 0,
    async get<T>(key: string): Promise<T | null> {
      cache._gets++;
      return (store.get(key) as T) ?? null;
    },
    async set(key: string, data: unknown, _ttl?: number): Promise<void> {
      cache._sets++;
      store.set(key, data);
    },
    async invalidate(key: string): Promise<void> {
      store.delete(key);
    },
  };
  return cache;
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
        { kind: 'item', medusaId: 'li_42', category: 'general', amountStr: '100.00' },
      );

      expect('line_item_id' in line ? line.line_item_id : null).toBe('li_42');
      expect(line.provider_id).toBe('opensalestax');
      // Critical: rate must be a percentage (6.875), NOT a fraction (0.06875).
      expect(line.rate).toBe(6.875);
      expect(line.name).toBe('State: Minnesota');
      expect(line.code).toBe('OST-STATE-minnesota');
    });

    it('maps to a ShippingTaxLineDTO when entry kind is shipping', () => {
      const line = OpenSalesTaxProvider.jurisdictionToTaxLine(
        { type: 'state', name: 'Minnesota', rate_pct: '6.875', tax: '0.6875' },
        { kind: 'shipping', medusaId: 'sl_99', category: 'general', amountStr: '10.00' },
      );

      expect('shipping_line_id' in line ? line.shipping_line_id : null).toBe('sl_99');
      expect('line_item_id' in line).toBe(false);
      expect(line.rate).toBe(6.875);
    });

    it('slugifies multi-word jurisdictions', () => {
      const line = OpenSalesTaxProvider.jurisdictionToTaxLine(
        { type: 'district', name: 'Hennepin County Transit Sales Tax', rate_pct: '0.500', tax: '0.5000' },
        { kind: 'item', medusaId: 'li_1', category: 'general', amountStr: '100.00' },
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

  describe('shipping-line tax (v0.2)', () => {
    it('sends shipping lines through the engine alongside item lines', async () => {
      const fetchMock = stubFetchOk({
        subtotal: '110.00',
        tax_total: '9.93',
        disclaimer: '',
        // 2 lines in / 2 lines out — order matches the request order
        lines: [
          { amount: '100.00', category: 'general', tax: '9.025', rate_pct: '9.025', jurisdictions: [
            { type: 'state', name: 'Minnesota', rate_pct: '6.875', tax: '6.8750' },
          ]},
          { amount: '10.00', category: 'general', tax: '0.9025', rate_pct: '9.025', jurisdictions: [
            { type: 'state', name: 'Minnesota', rate_pct: '6.875', tax: '0.6875' },
          ]},
        ],
      });
      const provider = new OpenSalesTaxProvider({ logger: fakeLogger }, { apiBaseUrl: 'http://stub' });

      const result = await provider.getTaxLines(
        [baseItemLine({ id: 'li_1' })],
        [baseShippingLine({ id: 'sl_1', price: 10 })],
        baseContext(),
      );

      const body = JSON.parse((fetchMock.mock.calls[0]?.[1] as { body: string }).body);
      expect(body.line_items).toHaveLength(2);
      expect(body.line_items[0]).toMatchObject({ amount: '100.00', category: 'general' });
      expect(body.line_items[1]).toMatchObject({ amount: '10.00', category: 'general' });

      // 2 returned tax lines: 1 item × 1 jurisdiction + 1 shipping × 1 jurisdiction
      expect(result).toHaveLength(2);
      const itemLine = result.find((l) => 'line_item_id' in l);
      const shippingLine = result.find((l) => 'shipping_line_id' in l);
      expect(itemLine && 'line_item_id' in itemLine ? itemLine.line_item_id : null).toBe('li_1');
      expect(shippingLine && 'shipping_line_id' in shippingLine ? shippingLine.shipping_line_id : null).toBe('sl_1');
    });

    it('skips shipping lines entirely when shippingCategory is empty string', async () => {
      const fetchMock = stubFetchOk({
        subtotal: '100.00',
        tax_total: '9.025',
        disclaimer: '',
        lines: [{ amount: '100.00', category: 'general', tax: '9.025', rate_pct: '9.025', jurisdictions: [
          { type: 'state', name: 'Minnesota', rate_pct: '6.875', tax: '6.8750' },
        ]}],
      });
      const provider = new OpenSalesTaxProvider(
        { logger: fakeLogger },
        { apiBaseUrl: 'http://stub', shippingCategory: '' },
      );

      const result = await provider.getTaxLines(
        [baseItemLine()],
        [baseShippingLine()],
        baseContext(),
      );

      const body = JSON.parse((fetchMock.mock.calls[0]?.[1] as { body: string }).body);
      // Only the item line; shipping was opted-out via empty shippingCategory.
      expect(body.line_items).toHaveLength(1);
      result.forEach((line) => {
        expect('shipping_line_id' in line).toBe(false);
      });
    });

    it('honors a configured shippingCategory like clothing', async () => {
      const fetchMock = stubFetchOk({
        subtotal: '15.00',
        tax_total: '0',
        disclaimer: '',
        lines: [{ amount: '15.00', category: 'clothing', tax: '0', rate_pct: '0', jurisdictions: [] }],
      });
      const provider = new OpenSalesTaxProvider(
        { logger: fakeLogger },
        { apiBaseUrl: 'http://stub', shippingCategory: 'clothing' },
      );

      await provider.getTaxLines([], [baseShippingLine({ price: 15 })], baseContext());

      const body = JSON.parse((fetchMock.mock.calls[0]?.[1] as { body: string }).body);
      expect(body.line_items[0]).toMatchObject({ amount: '15.00', category: 'clothing' });
    });

    it('falls back to general when shippingCategory is invalid', async () => {
      const fetchMock = stubFetchOk({
        subtotal: '10.00',
        tax_total: '0',
        disclaimer: '',
        lines: [{ amount: '10.00', category: 'general', tax: '0', rate_pct: '0', jurisdictions: [] }],
      });
      const provider = new OpenSalesTaxProvider(
        { logger: fakeLogger },
        { apiBaseUrl: 'http://stub', shippingCategory: 'not-a-real-category' },
      );

      await provider.getTaxLines([], [baseShippingLine()], baseContext());

      const body = JSON.parse((fetchMock.mock.calls[0]?.[1] as { body: string }).body);
      expect(body.line_items[0]).toMatchObject({ category: 'general' });
      expect(fakeLogger?.warn).toHaveBeenCalledWith(expect.stringContaining('shippingCategory'));
    });
  });

  describe('caching (v0.2)', () => {
    const sampleResponse = {
      subtotal: '100.00',
      tax_total: '9.025',
      disclaimer: '',
      lines: [{ amount: '100.00', category: 'general', tax: '9.025', rate_pct: '9.025', jurisdictions: [
        { type: 'state', name: 'Minnesota', rate_pct: '6.875', tax: '6.8750' },
        { type: 'city', name: 'Minneapolis', rate_pct: '0.500', tax: '0.5000' },
      ]}],
    };

    it('hits the engine on cache miss + populates the cache', async () => {
      const fetchMock = stubFetchOk(sampleResponse);
      const cache = makeFakeCache();
      const provider = new OpenSalesTaxProvider(
        { logger: fakeLogger, cache },
        { apiBaseUrl: 'http://stub' },
      );

      const result = await provider.getTaxLines([baseItemLine()], [], baseContext());

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(cache._gets).toBe(1);
      expect(cache._sets).toBe(1);
      expect(cache._store.size).toBe(1);
      expect(result).toHaveLength(2); // 2 jurisdictions
    });

    it('serves from cache on the second identical call (no engine hit)', async () => {
      const fetchMock = stubFetchOk(sampleResponse);
      const cache = makeFakeCache();
      const provider = new OpenSalesTaxProvider(
        { logger: fakeLogger, cache },
        { apiBaseUrl: 'http://stub' },
      );

      const r1 = await provider.getTaxLines([baseItemLine()], [], baseContext());
      const r2 = await provider.getTaxLines([baseItemLine()], [], baseContext());

      expect(fetchMock).toHaveBeenCalledTimes(1); // only 1 engine call across 2 invocations
      expect(cache._sets).toBe(1);
      expect(r1).toHaveLength(r2.length);
      expect(r1[0]?.name).toBe(r2[0]?.name);
    });

    it('produces different cache keys for different ZIPs', async () => {
      stubFetchOk(sampleResponse);
      const cache = makeFakeCache();
      const provider = new OpenSalesTaxProvider(
        { logger: fakeLogger, cache },
        { apiBaseUrl: 'http://stub' },
      );

      await provider.getTaxLines([baseItemLine()], [], {
        address: { country_code: 'US', postal_code: '55401' },
      });
      await provider.getTaxLines([baseItemLine()], [], {
        address: { country_code: 'US', postal_code: '94110' },
      });

      // Two distinct cache entries because ZIP changed.
      expect(cache._store.size).toBe(2);
    });

    it('produces the same cache key regardless of input order', async () => {
      stubFetchOk(sampleResponse);
      const cache = makeFakeCache();
      const provider = new OpenSalesTaxProvider(
        { logger: fakeLogger, cache },
        { apiBaseUrl: 'http://stub' },
      );

      const lineA = baseItemLine({ id: 'li_a' });
      const lineB = baseItemLine({ id: 'li_b' });

      await provider.getTaxLines([lineA, lineB], [], baseContext());
      await provider.getTaxLines([lineB, lineA], [], baseContext()); // reversed

      // Reordering shouldn't produce a new cache entry.
      expect(cache._store.size).toBe(1);
    });

    it('skips the cache entirely when cacheTtlSeconds is 0', async () => {
      const fetchMock = stubFetchOk(sampleResponse);
      const cache = makeFakeCache();
      const provider = new OpenSalesTaxProvider(
        { logger: fakeLogger, cache },
        { apiBaseUrl: 'http://stub', cacheTtlSeconds: 0 },
      );

      await provider.getTaxLines([baseItemLine()], [], baseContext());
      await provider.getTaxLines([baseItemLine()], [], baseContext());

      expect(fetchMock).toHaveBeenCalledTimes(2); // both calls hit engine
      expect(cache._gets).toBe(0);
      expect(cache._sets).toBe(0);
    });

    it('works correctly when no cache module is registered (no-op cache layer)', async () => {
      const fetchMock = stubFetchOk(sampleResponse);
      // Note: no `cache` in deps — simulates a host without the Cache module.
      const provider = new OpenSalesTaxProvider(
        { logger: fakeLogger },
        { apiBaseUrl: 'http://stub' },
      );

      const result = await provider.getTaxLines([baseItemLine()], [], baseContext());

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(result).toHaveLength(2);
    });

    it('continues working when cache.get throws', async () => {
      const fetchMock = stubFetchOk(sampleResponse);
      const cache: ICacheService = {
        async get(): Promise<null> { throw new Error('cache backend dead'); },
        async set(): Promise<void> { /* no-op */ },
        async invalidate(): Promise<void> { /* no-op */ },
      };
      const provider = new OpenSalesTaxProvider(
        { logger: fakeLogger, cache },
        { apiBaseUrl: 'http://stub' },
      );

      const result = await provider.getTaxLines([baseItemLine()], [], baseContext());

      // Cache failure shouldn't break tax calculation.
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(result.length).toBeGreaterThan(0);
      expect(fakeLogger?.warn).toHaveBeenCalledWith(expect.stringContaining('cache.get failed'));
    });

    it('continues working when cache.set throws', async () => {
      stubFetchOk(sampleResponse);
      const cache: ICacheService = {
        async get<T>(): Promise<T | null> { return null; },
        async set(): Promise<void> { throw new Error('cache backend dead'); },
        async invalidate(): Promise<void> { /* no-op */ },
      };
      const provider = new OpenSalesTaxProvider(
        { logger: fakeLogger, cache },
        { apiBaseUrl: 'http://stub' },
      );

      const result = await provider.getTaxLines([baseItemLine()], [], baseContext());

      expect(result.length).toBeGreaterThan(0);
      expect(fakeLogger?.warn).toHaveBeenCalledWith(expect.stringContaining('cache.set failed'));
    });
  });
});
