// Capitulation-bounce cbBTC bot for the 24h BTC race (bars-replay/v1).
//
// Idea: on a 1-minute cbBTC replay the money is in the washout. BTC bleeds
// slowly, then capitulates several percent in an hour and snaps back. This bot
// sits in cash through the bleed, buys the whole stake only once price has
// fallen hard *and* turned back up, then rides the snap-back with a take-profit
// and a trailing stop. In a genuine uptrend (price above its 120-bar mean and
// making fresh 60-bar highs) a momentum leg buys the breakout instead, so the
// bot still trades when the race window trends up instead of washing out.
//
// Protocol: the harness sends one `hello`, then one `batch` per bar (the bar
// that just closed, the fills of the previous batch's orders, and the account),
// and this bot answers every batch with exactly one reply echoing its seq.
// Orders decided on a batch fill at the next bar's open, so every decision
// here is made on closes only. No clock, no network, no randomness: the same
// bars always give the same orders, run after run.
//
// Entries (flat only, full cash, max slippage 200 bps vs the latest close):
//   A) capitulation: close >= 3% below the 120-bar high, 60-minute return
//      <= -1.5%, and the close bounced >= 0.3% off the 10-bar low.
//   B) mean reversion: close >= 2% below the 120-bar mean and below the
//      120-bar high by >= 2%, on an up bar (close above the previous close).
//   C) momentum (uptrend only): close above the 60-bar high by >= 0.2%,
//      above the 120-bar mean by >= 0.5%, and the 240-minute return > +0.5%.
// Exits (whole position, whichever comes first):
//   take profit +4.5% over cost, trailing stop 1.5% below the peak value
//   since entry, hard stop -2% under cost, max hold 360 bars.
// After any exit the bot waits 30 bars before it may enter again, so a
// choppy tape cannot whipsaw it straight back in.
//
// Sizing: one open position at most, up to 100% of equity. A full-size round
// trip pays roughly 24 bps in fees, slippage and pool impact, so entries
// demand a multi-percent dislocation and exits demand a multi-percent move.

import { BPS, runBars, type Bar, type BarsState, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';
const SMA_BARS = 120;
const HIGH_BARS = 120;
const LOW_BARS = 10;
const MOM_BARS = 60;
const TREND_BARS = 240;
const MAX_SLIPPAGE_BPS = 200;
const COOLDOWN_BARS = 30;
const MAX_HOLD_BARS = 360;

// Entry A: capitulation dip vs the 120-bar high, with a bounce off the low.
const DIP_A = 0.03;
const RET_60M_A = -0.015;
const BOUNCE_A = 0.003;
// Entry B: dislocation vs the 120-bar mean, on an up bar.
const DIP_SMA_B = 0.02;
const DIP_HIGH_B = 0.02;
// Entry C: momentum breakout, uptrend only.
const BREAK_C = 0.002;
const ABOVE_SMA_C = 0.005;
const RET_240M_C = 0.005;
// Exits, as integer thousandths: take profit +4.5% over cost (x1045/1000),
// trailing stop 1.5% below the peak value (x985/1000), hard stop -2% under
// cost (x980/1000).

const closes: number[] = [];
let smaSum = 0;
let peakValue = 0n;
let holdBars = 0;
let lastExitSeq = -1000000;

function sma120(): number | null {
  if (closes.length < SMA_BARS) return null;
  return smaSum / SMA_BARS;
}

function maxOf(values: number[]): number {
  let m = -Infinity;
  for (const v of values) if (v > m) m = v;
  return m;
}

function minOf(values: number[]): number {
  let m = Infinity;
  for (const v of values) if (v < m) m = v;
  return m;
}

await runBars({
  onBatch(state: BarsState, batch): (BuyInput | SellInput)[] {
    for (const bar of batch.bars) {
      if (bar.symbol !== SYMBOL) continue;
      const c = Number(bar.c);
      closes.push(c);
      smaSum += c;
      if (closes.length > SMA_BARS) smaSum -= closes[closes.length - SMA_BARS - 1];
    }
    if (state.warmingUp) return [];
    if (closes.length < SMA_BARS) return [];

    const c = closes[closes.length - 1];
    const prev = closes[closes.length - 2];
    const sma = sma120();
    if (sma === null) return [];
    const high120 = maxOf(closes.slice(-HIGH_BARS));
    const low10 = minOf(closes.slice(-LOW_BARS));
    const high60 = maxOf(closes.slice(-MOM_BARS));
    const ret60 = closes.length > 60 ? c / closes[closes.length - 61] - 1 : 0;
    const ret240 = closes.length > TREND_BARS ? c / closes[closes.length - TREND_BARS - 1] - 1 : 0;
    const dipVsHigh = c / high120 - 1;

    const held = state.positions.get(SYMBOL);
    if (held !== undefined) {
      // Cost and peak come from the filled position itself, never from the
      // notional decided a bar earlier: a buy the replay rejects leaves no
      // position, and a fill's fee and impact are already in its cost.
      const cost = held.cost;
      const value = state.value(SYMBOL, held.qty);
      if (value > peakValue) peakValue = value;
      holdBars += 1;
      const atTakeProfit = value * 1000n >= cost * 1045n;
      const atTrailing = value * 1000n <= peakValue * 985n;
      const atStop = value * 1000n <= cost * 980n;
      if (atTakeProfit || atTrailing || atStop || holdBars >= MAX_HOLD_BARS) {
        lastExitSeq = state.seq;
        peakValue = 0n;
        holdBars = 0;
        return [{ side: 'sell', symbol: SYMBOL, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS }];
      }
      return [];
    }
    peakValue = 0n;
    holdBars = 0;

    if (state.seq - lastExitSeq <= COOLDOWN_BARS) return [];
    const dipVsSma = c / sma - 1;
    const entryA = dipVsHigh <= -DIP_A && ret60 <= RET_60M_A && c >= low10 * (1 + BOUNCE_A);
    const entryB = dipVsSma <= -DIP_SMA_B && dipVsHigh <= -DIP_HIGH_B && c > prev;
    const entryC = c >= high60 * (1 + BREAK_C) && c >= sma * (1 + ABOVE_SMA_C) && ret240 > RET_240M_C;
    if (!entryA && !entryB && !entryC) return [];

    const stake = state.cash;
    if (stake < BigInt(state.hello.fees.min_notional_quote_units)) return [];
    const byWeight = (BigInt(state.hello.caps.max_weight_bps) * state.equity) / BPS;
    const notional = stake < byWeight ? stake : byWeight;
    if (notional < BigInt(state.hello.fees.min_notional_quote_units)) return [];
    return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: notional, max_slippage_bps: MAX_SLIPPAGE_BPS }];
  },
});
