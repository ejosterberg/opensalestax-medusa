// SPDX-License-Identifier: Apache-2.0

import { ModuleProvider, Modules } from '@medusajs/framework/utils';
import { OpenSalesTaxProvider } from './service';

export default ModuleProvider(Modules.TAX, {
  services: [OpenSalesTaxProvider],
});

export { OpenSalesTaxProvider } from './service';
export type { OpenSalesTaxProviderOptions } from './service';

// Re-export the SDK's public surface so downstream consumers of this
// connector can import shared types without an explicit
// `@ejosterberg/opensalestax` dependency. Names mirror the SDK as of
// v0.1.0; the old `CalculateRequest` / `CalculateResponse` /
// `CalculateLineItem` from the v0.1.x embedded client have been
// replaced by `Address` / `LineItem` / `CalculationResult`.
export {
  OpenSalesTaxClient,
  OpenSalesTaxAPIError,
  OpenSalesTaxNetworkError,
} from '@ejosterberg/opensalestax';
export type {
  Address,
  CalculatedLine,
  CalculationResult,
  JurisdictionRate,
  LineItem,
  OpenSalesTaxClientOptions,
} from '@ejosterberg/opensalestax';
