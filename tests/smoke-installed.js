// SPDX-License-Identifier: Apache-2.0 OR GPL-2.0-or-later

// Smoke test for the installed @ejosterberg/medusa-plugin-opensalestax in
// a real Medusa app's node_modules. Run from the Medusa app's working
// directory:
//
//   node smoke-installed.js
//
// Hits the live OpenSalesTax engine and verifies one Minneapolis cart
// returns the expected 6 jurisdictions summing to 9.025%.

const { OpenSalesTaxProvider } = require('@ejosterberg/medusa-plugin-opensalestax/providers/opensalestax');

const provider = new OpenSalesTaxProvider(
  { logger: console },
  {
    apiBaseUrl: process.env.OPENSALESTAX_URL || 'http://10.32.161.126:8080',
    defaultCategory: 'general',
  },
);

console.log('Provider identifier:', provider.getIdentifier());

const itemLines = [
  {
    line_item: {
      id: 'li_test_1',
      product_id: 'p_test',
      quantity: 1,
      unit_price: 100,
      currency_code: 'usd',
    },
    rates: [],
  },
];

const context = {
  address: {
    country_code: 'US',
    province_code: 'mn',
    postal_code: '55401',
    city: 'Minneapolis',
  },
};

provider
  .getTaxLines(itemLines, [], context)
  .then((result) => {
    console.log('Returned ' + result.length + ' tax lines:');
    let sum = 0;
    for (const l of result) {
      console.log(
        '  ' + l.name + '  ' + l.rate + '%  (line_item_id=' + l.line_item_id + ', code=' + l.code + ')',
      );
      sum += l.rate;
    }
    console.log('Sum: ' + sum.toFixed(3) + '% (expect 9.025%)');
    if (Math.abs(sum - 9.025) > 0.001) {
      console.error('FAIL: sum differs from expected');
      process.exit(1);
    }
    if (result.length !== 6) {
      console.error('FAIL: expected 6 jurisdictions, got ' + result.length);
      process.exit(1);
    }
    console.log('PASS');
  })
  .catch((e) => {
    console.error('FAIL:', e.message);
    process.exit(1);
  });
