// SPDX-License-Identifier: Apache-2.0

import type {
  ITaxProvider,
  Logger,
  ItemTaxCalculationLine,
  ShippingTaxCalculationLine,
  TaxCalculationContext,
  ItemTaxLineDTO,
  ShippingTaxLineDTO,
} from '@medusajs/framework/types';

import { OpenSalesTaxClient, OpenSalesTaxApiError } from './client';
import type { CalculatedLine, CalculateRequest, JurisdictionRate } from './client';

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
 *       timeoutMs: 5000                                // optional, default 5000
 *     }
 *   }
 */
export interface OpenSalesTaxProviderOptions {
  apiBaseUrl: string;
  apiKey?: string;
  defaultCategory?: string;
  categoryByProductTypeId?: Record<string, string>;
  timeoutMs?: number;
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
const SUPPORTED_COUNTRY = 'US';
const SUPPORTED_CURRENCY = 'usd';

interface InjectedDeps {
  logger?: Logger;
}

/**
 * OpenSalesTax tax provider for Medusa v2.
 *
 * Implements `ITaxProvider`. On every `getTaxLines` call, this provider:
 *   1. Filters US-only, USD-only line items (returns [] for anything else —
 *      the engine is destination-based US-only, USD-only by design).
 *   2. Maps Medusa's `product_type_id` to one of the OST engine's 6 tax
 *      categories via the `categoryByProductTypeId` option (with a
 *      configurable default for unmapped types).
 *   3. Calls `POST /v1/calculate` with all taxable lines in a single batch.
 *   4. Returns one ItemTaxLineDTO per (line × jurisdiction) so Medusa shows
 *      the per-state/county/city/district breakdown in the order summary.
 *
 * Shipping tax is intentionally NOT computed in v0.1 — most US states tax
 * shipping at the destination's general rate, but the rules are non-trivial
 * (some states exempt shipping when separately stated, others tax it
 * proportionally to taxable items only). v0.2 will add shipping handling
 * once the engine surfaces a shipping-specific category.
 *
 * Caching: NOT implemented in v0.1. Medusa calls `getTaxLines` on every
 * cart-totals recompute; for high-traffic stores this should be wrapped
 * in a short-TTL cache (Medusa's ICacheService via DI, ~60s). v0.2.
 */
export class OpenSalesTaxProvider implements ITaxProvider {
  static readonly identifier = 'opensalestax';

  private readonly logger: Logger | undefined;
  private readonly client: OpenSalesTaxClient;
  private readonly options: OpenSalesTaxProviderOptions;

  constructor(deps: InjectedDeps, options: OpenSalesTaxProviderOptions) {
    if (!options || typeof options.apiBaseUrl !== 'string' || options.apiBaseUrl.trim() === '') {
      throw new Error(
        '[opensalestax] `apiBaseUrl` is required in the provider options. ' +
          'Set it to your engine\'s base URL, e.g. http://opensalestax:8080.',
      );
    }
    this.logger = deps.logger;
    this.options = {
      defaultCategory: DEFAULT_CATEGORY,
      categoryByProductTypeId: {},
      timeoutMs: 5000,
      ...options,
    };
    this.client = new OpenSalesTaxClient({
      baseUrl: this.options.apiBaseUrl,
      apiKey: this.options.apiKey,
      timeoutMs: this.options.timeoutMs ?? 5000,
    });
  }

  getIdentifier(): string {
    return OpenSalesTaxProvider.identifier;
  }

  async getTaxLines(
    itemLines: ItemTaxCalculationLine[],
    _shippingLines: ShippingTaxCalculationLine[],
    context: TaxCalculationContext,
  ): Promise<(ItemTaxLineDTO | ShippingTaxLineDTO)[]> {
    // Country gate — engine is US-only.
    const country = context.address?.country_code?.toUpperCase();
    if (country !== SUPPORTED_COUNTRY) {
      return [];
    }

    // ZIP gate — engine needs a 5-digit US ZIP.
    const zip5 = OpenSalesTaxProvider.extractZip5(context.address?.postal_code);
    if (zip5 === null) {
      return [];
    }

    // Build the engine payload. Each Medusa item maps to an OST line.
    // We pass the line index as the engine's "id" so we can correlate
    // the response back to Medusa's line_item_id without a second loop.
    const taxableLines: Array<{ idx: number; medusaLine: ItemTaxCalculationLine; category: string }> = [];
    for (let i = 0; i < itemLines.length; i++) {
      const line = itemLines[i];
      if (line === undefined) {
        continue;
      }
      const currency = line.line_item.currency_code?.toLowerCase();
      if (currency !== undefined && currency !== SUPPORTED_CURRENCY) {
        continue; // non-USD line; engine doesn't handle it
      }
      const category = this.resolveCategory(line);
      if (category === '') {
        continue; // explicitly non-taxable
      }
      taxableLines.push({ idx: i, medusaLine: line, category });
    }

    if (taxableLines.length === 0) {
      return [];
    }

    const request: CalculateRequest = {
      address: { zip5 },
      line_items: taxableLines.map((l) => ({
        amount: OpenSalesTaxProvider.unitAmount(l.medusaLine),
        category: l.category,
      })),
    };

    let response;
    try {
      response = await this.client.calculate(request);
    } catch (err) {
      const message = err instanceof OpenSalesTaxApiError ? err.message : String(err);
      this.logger?.error?.(`[opensalestax] calculate failed: ${message}`);
      // Return [] — Medusa surfaces thrown errors to the customer mid-checkout.
      // A failed engine call should fail-soft to "no tax line" rather than
      // blocking checkout.
      return [];
    }

    return OpenSalesTaxProvider.mapResponseToTaxLines(response.lines, taxableLines);
  }

  /** Extract a 5-digit US ZIP from a postal_code string, or null if not parseable. */
  static extractZip5(postalCode: string | null | undefined): string | null {
    if (postalCode === null || postalCode === undefined) {
      return null;
    }
    const digits = postalCode.replace(/\D/g, '');
    return digits.length >= 5 ? digits.slice(0, 5) : null;
  }

  /** Map a single Medusa line to a 6-category OST category via merchant-configured options. */
  private resolveCategory(line: ItemTaxCalculationLine): string {
    const map = this.options.categoryByProductTypeId ?? {};
    const productTypeId = line.line_item.product_type_id;
    if (typeof productTypeId === 'string' && productTypeId in map) {
      const mapped = map[productTypeId];
      if (typeof mapped === 'string') {
        // Empty string is allowed (means "skip this line — non-taxable").
        if (mapped === '' || VALID_CATEGORIES.has(mapped)) {
          return mapped;
        }
        this.logger?.warn?.(
          `[opensalestax] product_type_id ${productTypeId} mapped to invalid category ` +
            `"${mapped}"; falling back to default.`,
        );
      }
    }
    const fallback = this.options.defaultCategory ?? DEFAULT_CATEGORY;
    return VALID_CATEGORIES.has(fallback) ? fallback : DEFAULT_CATEGORY;
  }

  /** Compute the pre-tax unit amount for one Medusa line, formatted as the engine expects. */
  static unitAmount(line: ItemTaxCalculationLine): string {
    const lineItem = line.line_item;
    // `unit_price` is the canonical pre-tax price per unit. `quantity` defaults
    // to 1 if the line type doesn't track it (Medusa's TaxableItemDTO marks
    // both as optional but in practice they're populated for cart items).
    const unitPriceRaw = (lineItem as { unit_price?: number | string | null }).unit_price ?? 0;
    const quantityRaw = (lineItem as { quantity?: number | string | null }).quantity ?? 1;
    const unitPrice = typeof unitPriceRaw === 'string' ? parseFloat(unitPriceRaw) : Number(unitPriceRaw);
    const quantity = typeof quantityRaw === 'string' ? parseFloat(quantityRaw) : Number(quantityRaw);
    const total = (Number.isFinite(unitPrice) ? unitPrice : 0) * (Number.isFinite(quantity) ? quantity : 1);
    return total.toFixed(2);
  }

  /**
   * Convert engine response lines into Medusa tax lines, one per
   * (input-line × jurisdiction). Multiple jurisdictions per item is
   * intentional — Medusa sums them and shows the per-jurisdiction breakdown
   * in the order summary, mirroring the OpenSalesTax audit panel.
   */
  static mapResponseToTaxLines(
    engineLines: CalculatedLine[],
    taxableLines: Array<{ idx: number; medusaLine: ItemTaxCalculationLine; category: string }>,
  ): ItemTaxLineDTO[] {
    const out: ItemTaxLineDTO[] = [];
    // Engine returns lines in the same order we sent them.
    for (let i = 0; i < engineLines.length; i++) {
      const engineLine = engineLines[i];
      const taxable = taxableLines[i];
      if (engineLine === undefined || taxable === undefined) {
        continue;
      }
      const lineItemId = taxable.medusaLine.line_item.id;
      for (const j of engineLine.jurisdictions) {
        out.push(OpenSalesTaxProvider.jurisdictionToTaxLine(j, lineItemId));
      }
    }
    return out;
  }

  static jurisdictionToTaxLine(j: JurisdictionRate, lineItemId: string): ItemTaxLineDTO {
    const ratePct = parseFloat(j.rate_pct);
    return {
      line_item_id: lineItemId,
      // Medusa's `rate` is a percentage (9.75 = 9.75%, NOT 0.0975).
      rate: Number.isFinite(ratePct) ? ratePct : 0,
      name: `${OpenSalesTaxProvider.titleCaseType(j.type)}: ${j.name}`,
      code: `OST-${j.type.toUpperCase()}-${OpenSalesTaxProvider.slug(j.name)}`,
      provider_id: OpenSalesTaxProvider.identifier,
    };
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
