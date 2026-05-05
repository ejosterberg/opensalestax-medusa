// SPDX-License-Identifier: Apache-2.0

import { ModuleProvider, Modules } from '@medusajs/framework/utils';
import { OpenSalesTaxProvider } from './service';

export default ModuleProvider(Modules.TAX, {
  services: [OpenSalesTaxProvider],
});

export { OpenSalesTaxProvider } from './service';
export type { OpenSalesTaxProviderOptions } from './service';
export { OpenSalesTaxClient, OpenSalesTaxApiError } from './client';
export type {
  OpenSalesTaxClientOptions,
  CalculateRequest,
  CalculateResponse,
  CalculatedLine,
  CalculateLineItem,
  JurisdictionRate,
} from './client';
