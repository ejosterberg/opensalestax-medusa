// SPDX-License-Identifier: Apache-2.0 OR GPL-2.0-or-later

import { createHash } from 'node:crypto';

import type {
  ICacheService,
  ITaxProvider,
  Logger,
  ItemTaxCalculationLine,
  ShippingTaxCalculationLine,
  TaxCalculationContext,
  ItemTaxLineDTO,
  ShippingTaxLineDTO,
} from '@medusajs/framework/types';

import {
  OpenSalesTaxClient,
  OpenSalesTaxAPIError,
  OpenSalesTaxNetworkError,
} from '@ejosterberg/opensalestax';
import type {
  Address,
  CalculatedLine,
  CalculationResult,
  JurisdictionRate,
  LineItem,
} from '@ejosterberg/opensalestax';

/**
 * Plugin options as passed via medusa-config.ts.
 *
 * @example
 *   {
 *     resolve: "@ejosterberg/medusa-plugin-opensalestax/providers/opensalestax",
 *     id: "opensalestax",
 *     options: {
 *       apiBaseUrl: process.env.OPENSALESTAX_URL,
 *       apiKey:     process.env.OPENSALESTAX_API_KEY, // optional
 *       defaultCategory: "general",                    // optional, defaults to "general"
 *       categoryByProductTypeId: {                     // optional
 *         "ptyp_clothing":   "clothing",
 *         "ptyp_groceries":  "groceries",
 *         "ptyp_giftcards":  "",                       // empty = non-taxable
 *       },
 *       shippingCategory: "general",                   // v0.2: shipping category, "" to skip
 *       timeoutMs: 5000,                               // optional, default 5000
 *       cacheTtlSeconds: 60,                           // v0.2: cache TTL, 0 to disable
 *     }
 *   }
 */
export interface OpenSalesTaxProviderOptions {
  apiBaseUrl: string;
  apiKey?: string;
  defaultCategory?: string;
  categoryByProductTypeId?: Record<string, string>;
  /** v0.2: OST category for shipping lines. Default `"general"`. Empty string skips. */
  shippingCategory?: string;
  timeoutMs?: number;
  /** v0.2: cache TTL in seconds. Default 60. Set to 0 to disable caching. */
  cacheTtlSeconds?: number;
}

/** Six categories the OpenSalesTax engine accepts. Empty string = non-taxable. */
const VALID_CATEGORIES = new Set([
  'general',
  'clothing',
  'groceries',
  'prescription_drugs',
  'prepared_food',
  'digital_goods',
]);

const DEFAULT_CATEGORY = 'general';
const DEFAULT_SHIPPING_CATEGORY = 'general';
const DEFAULT_CACHE_TTL_SECONDS = 60;
const SUPPORTED_COUNTRY = 'US';
const SUPPORTED_CURRENCY = 'usd';
const CACHE_KEY_PREFIX = 'opensalestax:v1';

interface InjectedDeps {
  logger?: Logger;
  /**
   * Medusa's Cache module, registered as `cache` in the Awilix container
   * (matches `Modules.CACHE`). Optional â€” if the host app hasn't configured
   * a cache module the provider degrades to no-cache (every call hits the
   * engine) but still functions correctly.
   */
  cache?: ICacheService;
}

/** Internal: a Medusa line + its resolved OST category, ready to send to the engine. */
type TaxableEntry =
  | { kind: 'item'; medusaId: string; category: string; amountStr: string }
  | { kind: 'shipping'; medusaId: string; category: string; amountStr: string };

/**
 * OpenSalesTax tax provider for Medusa v2.
 *
 * Implements `ITaxProvider`. On every `getTaxLines` call, this provider:
 *   1. Filters US-only, USD-only line items (returns [] for anything else â€”
 *      the engine is destination-based US-only, USD-only by design).
 *   2. Maps Medusa's `product_type_id` to one of the OST engine's 6 tax
 *      categories via the `categoryByProductTypeId` option (with a
 *      configurable default for unmapped types).
 *   3. Sends item AND shipping lines through the engine in a single batch.
 *      Shipping lines use the `shippingCategory` option (default `"general"`).
 *   4. Caches the engine response under a content-addressed key (60s TTL by
 *      default) so the typical "customer types ZIP, Medusa recomputes cart
 *      totals 5 times" pattern hits the engine once, not five times.
 *   5. Returns one tax line per (Medusa line Ã— jurisdiction) so the order
 *      summary shows the full state/county/city/district breakdown.
 *
 * Caching uses Medusa's `ICacheService` from the container under
 * `Modules.CACHE` ("cache"). The key is content-addressed:
 *   `opensalestax:v1:{zip5}:{sha1(canonical-payload-json)}`
 * so any change to the inputs (ZIP, line categories, line amounts) produces
 * a new key. Bumping the prefix invalidates all cached entries.
 *
 * If no cache module is registered (host app didn't configure one), the
 * provider gracefully no-ops the cache layer and every call hits the engine.
 *
 * v0.2 limitations (planned for later):
 *   - Refund / return tax integration. Medusa's return flow has its own tax
 *     path; we don't yet capture per-order breakdown for refund proration.
 */
export class OpenSalesTaxProvider implements ITaxProvider {
  static readonly identifier = 'opensalestax';

  private readonly logger: Logger | undefined;
  private readonly cache: ICacheService | undefined;
  private readonly client: OpenSalesTaxClient;
  private readonly options: Required<Omit<OpenSalesTaxProviderOptions, 'apiKey' | 'categoryByProductTypeId'>> & {
    apiKey?: string;
    categoryByProductTypeId: Record<string, string>;
  };

  constructor(deps: InjectedDeps, options: OpenSalesTaxProviderOptions) {
    if (!options || typeof options.apiBaseUrl !== 'string' || options.apiBaseUrl.trim() === '') {
      throw new Error(
        '[opensalestax] `apiBaseUrl` is required in the provider options. ' +
          'Set it to your engine\'s base URL, e.g. http://opensalestax:8080.',
      );
    }
    this.logger = deps.logger;
    this.cache = deps.cache;
    this.options = {
      apiBaseUrl: options.apiBaseUrl,
      apiKey: options.apiKey,
      defaultCategory: options.defaultCategory ?? DEFAULT_CATEGORY,
      categoryByProductTypeId: options.categoryByProductTypeId ?? {},
      shippingCategory: options.shippingCategory ?? DEFAULT_SHIPPING_CATEGORY,
      timeoutMs: options.timeoutMs ?? 5000,
      cacheTtlSeconds: options.cacheTtlSeconds ?? DEFAULT_CACHE_TTL_SECONDS,
    };
    this.client = new OpenSalesTaxClient({
      baseUrl: this.options.apiBaseUrl,
      apiKey: this.options.apiKey ?? null,
      timeoutMs: this.options.timeoutMs,
      // Medusa deployments commonly run the engine on the same
      // private network (Docker compose, K8s). The SDK's SSRF
      // defense is off by default for this deployment shape.
      allowPrivate: true,
    });
  }

  getIdentifier(): string {
    return OpenSalesTaxProvider.identifier;
  }

  async getTaxLines(
    itemLines: ItemTaxCalculationLine[],
    shippingLines: ShippingTaxCalculationLine[],
    context: TaxCalculationContext,
  ): Promise<(ItemTaxLineDTO | ShippingTaxLineDTO)[]> {
    // Country gate â€” engine is US-only.
    const country = context.address?.country_code?.toUpperCase();
    if (country !== SUPPORTED_COUNTRY) {
      return [];
    }

    // ZIP gate â€” engine needs a 5-digit US ZIP.
    const zip5 = OpenSalesTaxProvider.extractZip5(context.address?.postal_code);
    if (zip5 === null) {
      return [];
    }

    // Build the engine payload across BOTH item lines and shipping lines.
    const taxable: TaxableEntry[] = [];
    for (const line of itemLines) {
      const entry = this.resolveItemEntry(line);
      if (entry !== null) {
        taxable.push(entry);
      }
    }
    for (const line of shippingLines) {
      const entry = this.resolveShippingEntry(line);
      if (entry !== null) {
        taxable.push(entry);
      }
    }

    if (taxable.length === 0) {
      return [];
    }

    const ostAddress: Address = { zip5 };
    const lineItems: LineItem[] = taxable.map((t) => ({
      amount: t.amountStr,
      category: t.category,
    }));

    // Try cache first.
    const cacheKey = OpenSalesTaxProvider.buildCacheKey(zip5, taxable);
    const cached = await this.cacheGet(cacheKey);
    if (cached !== null) {
      return OpenSalesTaxProvider.mapResponseToTaxLines(cached.lines, taxable);
    }

    let response: CalculationResult;
    try {
      response = await this.client.calculate(ostAddress, lineItems);
    } catch (err) {
      const message =
        err instanceof OpenSalesTaxAPIError || err instanceof OpenSalesTaxNetworkError
          ? err.message
          : String(err);
      this.logger?.error?.(`[opensalestax] calculate failed: ${message}`);
      // Return [] â€” Medusa surfaces thrown errors to the customer mid-checkout.
      return [];
    }

    await this.cacheSet(cacheKey, response);

    return OpenSalesTaxProvider.mapResponseToTaxLines(response.lines, taxable);
  }

  /** Extract a 5-digit US ZIP from a postal_code string, or null if not parseable. */
  static extractZip5(postalCode: string | null | undefined): string | null {
    if (postalCode === null || postalCode === undefined) {
      return null;
    }
    const digits = postalCode.replace(/\D/g, '');
    return digits.length >= 5 ? digits.slice(0, 5) : null;
  }

  private resolveItemEntry(line: ItemTaxCalculationLine): TaxableEntry | null {
    const currency = line.line_item.currency_code?.toLowerCase();
    if (currency !== undefined && currency !== SUPPORTED_CURRENCY) {
      return null;
    }
    const category = this.resolveCategory(line);
    if (category === '') {
      return null;
    }
    return {
      kind: 'item',
      medusaId: line.line_item.id,
      category,
      amountStr: OpenSalesTaxProvider.unitAmount(line),
    };
  }

  private resolveShippingEntry(line: ShippingTaxCalculationLine): TaxableEntry | null {
    const currency = line.shipping_line.currency_code?.toLowerCase();
    if (currency !== undefined && currency !== SUPPORTED_CURRENCY) {
      return null;
    }
    const category = this.options.shippingCategory;
    if (category === '') {
      return null; // merchant explicitly opted out of shipping tax
    }
    if (!VALID_CATEGORIES.has(category)) {
      this.logger?.warn?.(
        `[opensalestax] shippingCategory "${category}" is not a valid OST category; ` +
          `falling back to "general".`,
      );
    }
    const safeCategory = VALID_CATEGORIES.has(category) ? category : DEFAULT_SHIPPING_CATEGORY;
    return {
      kind: 'shipping',
      medusaId: line.shipping_line.id,
      category: safeCategory,
      amountStr: OpenSalesTaxProvider.shippingAmount(line),
    };
  }

  /** Map a single Medusa line to a 6-category OST category via merchant-configured options. */
  private resolveCategory(line: ItemTaxCalculationLine): string {
    const map = this.options.categoryByProductTypeId;
    const productTypeId = line.line_item.product_type_id;
    if (typeof productTypeId === 'string' && productTypeId in map) {
      const mapped = map[productTypeId];
      if (typeof mapped === 'string') {
        // Empty string is allowed (means "skip this line â€” non-taxable").
        if (mapped === '' || VALID_CATEGORIES.has(mapped)) {
          return mapped;
        }
        this.logger?.warn?.(
          `[opensalestax] product_type_id ${productTypeId} mapped to invalid category ` +
            `"${mapped}"; falling back to default.`,
        );
      }
    }
    const fallback = this.options.defaultCategory;
    return VALID_CATEGORIES.has(fallback) ? fallback : DEFAULT_CATEGORY;
  }

  /** Compute the pre-tax unit amount for one Medusa item line, formatted as the engine expects. */
  static unitAmount(line: ItemTaxCalculationLine): string {
    const lineItem = line.line_item;
    const unitPriceRaw = (lineItem as { unit_price?: number | string | null }).unit_price ?? 0;
    const quantityRaw = (lineItem as { quantity?: number | string | null }).quantity ?? 1;
    const unitPrice = typeof unitPriceRaw === 'string' ? parseFloat(unitPriceRaw) : Number(unitPriceRaw);
    const quantity = typeof quantityRaw === 'string' ? parseFloat(quantityRaw) : Number(quantityRaw);
    const total = (Number.isFinite(unitPrice) ? unitPrice : 0) * (Number.isFinite(quantity) ? quantity : 1);
    return total.toFixed(2);
  }

  /** Compute the shipping amount for one Medusa shipping line. */
  static shippingAmount(line: ShippingTaxCalculationLine): string {
    const sl = line.shipping_line as { unit_price?: number | string | null };
    const raw = sl.unit_price ?? 0;
    const value = typeof raw === 'string' ? parseFloat(raw) : Number(raw);
    return (Number.isFinite(value) ? value : 0).toFixed(2);
  }

  /**
   * Convert engine response lines into Medusa tax lines, one per
   * (Medusa-line Ã— jurisdiction). For shipping lines the DTO carries
   * `shipping_line_id`; for item lines, `line_item_id`.
   */
  static mapResponseToTaxLines(
    engineLines: CalculatedLine[],
    taxable: TaxableEntry[],
  ): (ItemTaxLineDTO | ShippingTaxLineDTO)[] {
    const out: (ItemTaxLineDTO | ShippingTaxLineDTO)[] = [];
    for (let i = 0; i < engineLines.length; i++) {
      const engineLine = engineLines[i];
      const entry = taxable[i];
      if (engineLine === undefined || entry === undefined) {
        continue;
      }
      for (const j of engineLine.jurisdictions) {
        out.push(OpenSalesTaxProvider.jurisdictionToTaxLine(j, entry));
      }
    }
    return out;
  }

  static jurisdictionToTaxLine(j: JurisdictionRate, entry: TaxableEntry): ItemTaxLineDTO | ShippingTaxLineDTO {
    const ratePct = parseFloat(j.ratePct);
    const base = {
      // Medusa's `rate` is a percentage (9.75 = 9.75%, NOT 0.0975).
      rate: Number.isFinite(ratePct) ? ratePct : 0,
      name: `${OpenSalesTaxProvider.titleCaseType(j.type)}: ${j.name}`,
      code: `OST-${j.type.toUpperCase()}-${OpenSalesTaxProvider.slug(j.name)}`,
      provider_id: OpenSalesTaxProvider.identifier,
    };
    if (entry.kind === 'shipping') {
      return { ...base, shipping_line_id: entry.medusaId };
    }
    return { ...base, line_item_id: entry.medusaId };
  }

  /**
   * Content-address the cache key on (zip5 Ã— ordered taxable entries).
   * Any change to inputs produces a new key. Versioning prefix lets us
   * invalidate everything by bumping the prefix in a future release.
   */
  static buildCacheKey(zip5: string, taxable: TaxableEntry[]): string {
    // Sort entries to make the key deterministic regardless of input order.
    const canonical = [...taxable]
      .sort((a, b) => {
        if (a.kind !== b.kind) {
          return a.kind < b.kind ? -1 : 1;
        }
        if (a.medusaId !== b.medusaId) {
          return a.medusaId < b.medusaId ? -1 : 1;
        }
        return 0;
      })
      .map((t) => `${t.kind}|${t.medusaId}|${t.category}|${t.amountStr}`)
      .join(';');
    const hash = createHash('sha1').update(canonical).digest('hex');
    return `${CACHE_KEY_PREFIX}:${zip5}:${hash}`;
  }

  private async cacheGet(key: string): Promise<CalculationResult | null> {
    if (!this.cache || this.options.cacheTtlSeconds <= 0) {
      return null;
    }
    try {
      const got = await this.cache.get<CalculationResult>(key);
      return got ?? null;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger?.warn?.(`[opensalestax] cache.get failed (continuing): ${message}`);
      return null;
    }
  }

  private async cacheSet(key: string, value: CalculationResult): Promise<void> {
    if (!this.cache || this.options.cacheTtlSeconds <= 0) {
      return;
    }
    try {
      await this.cache.set(key, value, this.options.cacheTtlSeconds);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger?.warn?.(`[opensalestax] cache.set failed (continuing): ${message}`);
    }
  }

  private static titleCaseType(type: string): string {
    if (type.length === 0) {
      return type;
    }
    return type.charAt(0).toUpperCase() + type.slice(1);
  }

  private static slug(s: string): string {
    return s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
  }
}
