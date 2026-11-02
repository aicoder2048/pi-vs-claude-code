import type { OptionSnapshot } from '../../../src/business/types.ts';

const results = (['call', 'put'] satisfies OptionSnapshot['side'][]).flatMap(side =>
  Array.from({ length: 12 }, (_, index) => {
    const strike = 100 + index;
    return {
      details: {
        ticker: `O:NIMB261106${side === 'call' ? 'C' : 'P'}${String(strike * 1000).padStart(8, '0')}`,
        contract_type: side, expiration_date: '2026-11-06', strike_price: strike,
      },
      underlying_asset: { ticker: 'NIMB', price: 106 },
      last_quote: { bid: 1, ask: 1.2, last_updated: '1793390400123456789' },
      implied_volatility: 0.32,
      greeks: { delta: side === 'call' ? 0.18 : -0.18, gamma: 0.04, theta: -0.06, vega: 0.11 },
      open_interest: 100, day: { volume: 10 },
    };
  }));

export default { status: 'OK', results };
