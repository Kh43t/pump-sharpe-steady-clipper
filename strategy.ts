// SteadyClipper — a Sharpe-first paper bot for the pump.fun bonding-curve replay.
//
// The score is an hourly Sharpe ratio over one 6-hour window, so the bot optimises
// for a smooth equity curve, not a big number: many small, quick, high-conviction
// scalps spread evenly through the window, each with a tight take-profit, a tight
// stop, and a short maximum hold. One lucky runner cannot carry the Sharpe; one
// long bag can sink it.
//
// Entry: a curve whose recent tape shows accelerating buy pressure from many
// distinct wallets, price rising but not yet parabolic, sitting near its window
// high, with the creator still holding. First buys are small; the bot adds once,
// into strength only, and never chases a curve that already ran away.
//
// Exit: the first of take-profit, stop-loss, a trailing stop armed after a small
// gain, a fade in net flow, a creator sale, a single large sell, staleness, or a
// hard time limit. Positions are always sold whole.
//
// Guardrails: a pacing probe keeps the run above the 20-coin / 0.01-SOL round-trip
// minimum even on a quiet stretch, and total exposure is capped so a drawdown
// stays far under the 50% limit.
//
// Pure function of the batches the harness sends: no clock, no randomness, no I/O,
// iteration only over insertion-ordered maps, so the two graded executions agree
// byte for byte.

import type { Batch, Bot, BotState, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

export interface Knobs {
  /** Entry lookback, in slots. */
  window: number;
  /** Minimum net inflow (buys minus sells) over the window, SOL. */
  minNetSol: number;
  /** Minimum buy trades in the window. */
  minBuys: number;
  /** Minimum distinct buying wallets in the window. */
  minBuyers: number;
  /** Minimum price rise over the window, as a fraction. */
  minUp: number;
  /** Maximum price rise over the window (skip curves that already ran away). */
  maxUp: number;
  /** Newer-half net inflow must be at least this multiple of the older half. */
  accel: number;
  /** Price must sit at least this close to the window high. */
  nearHigh: number;
  /** Largest single wallet's share of window buy SOL, at most. */
  maxShare: number;
  /** Real SOL reserve bounds at entry. */
  minRqSol: number;
  maxRqSol: number;
  /** Minimum slots since the CreateEvent before an entry. */
  minAge: number;
  /** First buy per coin, SOL. */
  firstBuySol: number;
  /** Size of the single add-on buy, SOL. */
  addBuySol: number;
  /** Most SOL ever put into one coin. */
  maxPerCoinSol: number;
  /** Smallest buy worth the transaction fee, SOL. */
  minBuySol: number;
  /** Slippage allowed on buys, bps. Sells always go out wide open. */
  buySlipBps: number;
  /** Sell everything once value reaches cost * (1 + takeProfit). */
  takeProfit: number;
  /** Sell everything once value falls to cost * (1 - stopLoss). */
  stopLoss: number;
  /** Trailing stop arms once value reaches cost * (1 + trailArm). */
  trailArm: number;
  /** Once armed, sell on a fall of this share from the best value. */
  trailDrop: number;
  /** Exit when net SOL over fadeWindow slots falls below -fadeNetSol. */
  fadeWindow: number;
  fadeNetSol: number;
  /** Exit on any single recorded sell of at least this many SOL. */
  bigSellSol: number;
  /** Exit after holding this many slots. */
  maxHoldSlots: number;
  /** Slots to wait after an exit before the same curve may be bought again. */
  cooldownSlots: number;
  /** Most entries per curve over the run. */
  maxEntries: number;
  /** Add only once price is this far above the last buy's decision price. */
  addStep: number;
  /** Add only while the position is worth at least cost * (1 + addIfUp). */
  addIfUp: number;
  /** Most momentum positions open at once. */
  maxMain: number;
  /** Most SOL at cost across all positions at once. */
  maxExposureSol: number;
  /** Guardrail pacing: target coins and fills by the time paceSecs have elapsed. */
  targetCoins: number;
  targetFills: number;
  paceSecs: number;
  /** Size of a pacing probe buy, SOL. */
  probeSol: number;
  maxProbes: number;
  /** Equity circuit breaker: pause new entries for brakeSlots after equity falls
   *  brakeDrop below its running peak (tames the worst hours). 0 = off. */
  brakeDrop: number;
  brakeSlots: number;
}

export const DEFAULTS: Knobs = {
  window: 30,
  minNetSol: 0.2,
  minBuys: 3,
  minBuyers: 4,
  minUp: 0.04,
  maxUp: 1.2,
  accel: 2,
  nearHigh: 0.95,
  maxShare: 0.7,
  minRqSol: 2,
  maxRqSol: 80,
  minAge: 400,
  firstBuySol: 0.05,
  addBuySol: 0.2,
  maxPerCoinSol: 0.6,
  minBuySol: 0.01,
  buySlipBps: 200,
  takeProfit: 0.25,
  stopLoss: 0.08,
  trailArm: 0.05,
  trailDrop: 0.06,
  fadeWindow: 15,
  fadeNetSol: 1000,
  bigSellSol: 1000,
  maxHoldSlots: 400,
  cooldownSlots: 150,
  maxEntries: 2,
  addStep: 0.03,
  addIfUp: 0,
  maxMain: 5,
  maxExposureSol: 2.5,
  targetCoins: 28,
  targetFills: 280,
  paceSecs: 21600,
  probeSol: 0.02,
  maxProbes: 1,
  brakeDrop: 0.01,
  brakeSlots: 300,
};

const LAMPORTS = 1e9;
/** Curve fee share taken on each side (protocol + creator, 95 + 30 bps). */
const CURVE_FEE = 0.0125;

interface Tick {
  slot: number;
  buy: boolean;
  sol: number;
  user: string;
  price: number;
}

interface Tape {
  created: number | null;
  creator: string | null;
  ticks: Tick[];
  entries: number;
  lastExit: number;
  devSold: boolean;
}

interface Open {
  opened: number;
  peakValue: number;
  invested: number;
  exiting: boolean;
  filled: boolean;
  lastAddPrice: number;
  lastValue: number;
  adds: number;
}

export function createBot(k: Knobs = DEFAULTS): Bot {
  const tapes = new Map<Pubkey, Tape>();
  const open = new Map<Pubkey, Open>();
  /** Probe round trips in flight: false while buying, true once selling. */
  const probes = new Map<Pubkey, boolean>();
  let myFills = 0;
  const myCoins = new Set<Pubkey>();
  let firstTime: number | null = null;
  let lastTime: number | null = null;
  let peakEquity = 10;
  let brakeUntil = -1;
  let brakeFloor = 10;
  const keep = k.window + k.fadeWindow + 10;

  const tapeOf = (mint: Pubkey): Tape => {
    let t = tapes.get(mint);
    if (t === undefined) {
      t = { created: null, creator: null, ticks: [], entries: 0, lastExit: -1e12, devSold: false };
      tapes.set(mint, t);
    }
    return t;
  };

  /** Net recorded SOL (buys minus sells) over the last `w` slots. */
  const flow = (t: Tape, now: number, w: number): number => {
    let net = 0;
    for (let i = t.ticks.length - 1; i >= 0; i--) {
      const tr = t.ticks[i]!;
      if (tr.slot <= now - w) break;
      net += tr.buy ? tr.sol : -tr.sol;
    }
    return net;
  };

  /** Entry signal on a tape at slot `now` with real SOL reserve `rqSol`. */
  const surgeOk = (t: Tape, now: number, rqSol: number): boolean => {
    if (rqSol < k.minRqSol || rqSol > k.maxRqSol) return false;
    if (t.created === null || now - t.created < k.minAge) return false;
    if (t.devSold) return false;
    const from = now - k.window;
    const mid = now - k.window / 2;
    let buySol = 0;
    let sellSol = 0;
    let buys = 0;
    let netOld = 0;
    let netNew = 0;
    let startPrice = -1;
    let high = 0;
    let last = 0;
    const byUser = new Map<string, number>();
    for (const tr of t.ticks) {
      if (tr.slot <= from) {
        startPrice = tr.price;
        continue;
      }
      if (startPrice < 0) startPrice = tr.price;
      const signed = tr.buy ? tr.sol : -tr.sol;
      if (tr.slot <= mid) netOld += signed;
      else netNew += signed;
      if (tr.buy) {
        buySol += tr.sol;
        buys++;
        byUser.set(tr.user, (byUser.get(tr.user) ?? 0) + tr.sol);
      } else {
        sellSol += tr.sol;
      }
      if (tr.price > high) high = tr.price;
      last = tr.price;
    }
    if (buys < k.minBuys || byUser.size < k.minBuyers) return false;
    if (buySol - sellSol < k.minNetSol) return false;
    if (startPrice <= 0) return false;
    const up = last / startPrice - 1;
    if (up < k.minUp || up > k.maxUp) return false;
    if (last < high * k.nearHigh) return false;
    if (netNew <= 0 || netNew < k.accel * netOld) return false;
    let top = 0;
    for (const v of byUser.values()) if (v > top) top = v;
    if (top > k.maxShare * buySol) return false;
    return true;
  };

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const now = batch.slot;
      const bigSell = new Set<Pubkey>();
      const touched = new Set<Pubkey>();
      for (const f of batch.fills) {
        if (f.status === 'filled' && !f.client_id.startsWith('_')) {
          myFills++;
          myCoins.add(f.mint);
        }
      }
      for (const e of batch.events) {
        if (e.block_time !== null) {
          if (firstTime === null) firstTime = e.block_time;
          if (lastTime === null || e.block_time > lastTime) lastTime = e.block_time;
        }
        if (e.event === 'CreateEvent') {
          const t = tapeOf(e.mint);
          t.created = e.slot;
          t.creator = e.creator;
        } else if (e.event === 'TradeEvent') {
          const t = tapeOf(e.mint);
          const sol = Number(e.sol_amount) / LAMPORTS;
          t.ticks.push({
            slot: e.slot,
            buy: e.is_buy,
            sol,
            user: e.user,
            price: Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves),
          });
          touched.add(e.mint);
          if (!e.is_buy && t.creator !== null && e.user === t.creator) t.devSold = true;
          if (!e.is_buy && sol >= k.bigSellSol) bigSell.add(e.mint);
        }
      }
      for (const mint of touched) {
        const t = tapes.get(mint)!;
        let cut = 0;
        while (cut < t.ticks.length && t.ticks[cut]!.slot <= now - keep) cut++;
        if (cut > 0) t.ticks.splice(0, cut);
      }

      const marks = new Map(batch.marks.map((m) => [m.mint, m] as const));
      const pendingByMint = new Map<Pubkey, number>();
      for (const po of state.pending.values()) {
        pendingByMint.set(po.order.mint, (pendingByMint.get(po.order.mint) ?? 0) + 1);
      }
      const orders: OrderInput[] = [];
      const cap = state.hello.caps.max_orders_per_batch;
      const tx = Number(state.txFeeLamports()) / LAMPORTS;

      // Liquidation value of a held position right now, in SOL, fees deducted.
      const valueOf = (mint: Pubkey, tokens: number): number => {
        const curve = state.curves.get(mint);
        if (curve === undefined) return 0;
        const mk = marks.get(mint);
        const vq = mk ? Number(mk.virtual_quote_reserves) : Number(curve.virtual_quote_reserves);
        const vt = mk ? Number(mk.virtual_token_reserves) : Number(curve.virtual_token_reserves);
        return ((tokens * vq) / (vt + tokens) / LAMPORTS) * (1 - CURVE_FEE) - tx;
      };

      // 1. Exits first: every open position is checked against all exit rules.
      for (const [mint, h] of open) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) {
            open.delete(mint);
            const t = tapeOf(mint);
            if (h.filled) t.lastExit = now;
            else t.entries--;
          }
          continue;
        }
        h.filled = true;
        if (curve === undefined || curve.complete) continue;
        const tokens = Number(pos.token_amount);
        const value = valueOf(mint, tokens);
        const cost = Number(pos.cost_lamports) / LAMPORTS;
        if (value > h.peakValue) h.peakValue = value;
        h.lastValue = value;
        const t = tapeOf(mint);
        let exit = h.exiting;
        if (!exit && value >= cost * (1 + k.takeProfit)) exit = true;
        if (!exit && value <= cost * (1 - k.stopLoss)) exit = true;
        if (!exit && h.peakValue >= cost * (1 + k.trailArm) && value <= h.peakValue * (1 - k.trailDrop)) exit = true;
        if (!exit && flow(t, now, k.fadeWindow) < -k.fadeNetSol) exit = true;
        if (!exit && bigSell.has(mint)) exit = true;
        if (!exit && t.devSold) exit = true;
        if (!exit && now - h.opened > k.maxHoldSlots) exit = true;
        if (!exit) continue;
        h.exiting = true;
        let sellPending = false;
        for (const po of state.pending.values()) {
          if (po.order.mint === mint && po.order.side === 'sell') sellPending = true;
        }
        if (sellPending) continue;
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
      }

      // 2. Probe sells: a probe is dumped as soon as its buy lands.
      for (const [mint, selling] of probes) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) probes.delete(mint);
          continue;
        }
        if (curve === undefined || curve.complete || pendingByMint.has(mint)) continue;
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
        if (!selling) probes.set(mint, true);
      }

      // 3. Entries and the single add-on, into strength only.
      // Equity circuit breaker: after a sharp drop, stop opening for a while.
      const equityNow = (): number => {
        let eq = Number(state.cash) / LAMPORTS;
        for (const [mint, pos] of state.positions) eq += valueOf(mint, Number(pos.token_amount));
        return eq;
      };
      const eq = equityNow();
      if (eq > peakEquity) {
        peakEquity = eq;
        brakeFloor = eq;
      }
      // Ratchet: each pause needs a fresh drop below the last pause level, so a
      // single bad hour pauses the bot instead of stopping it for the run.
      if (k.brakeDrop > 0 && now >= brakeUntil && eq < brakeFloor * (1 - k.brakeDrop)) {
        brakeUntil = now + k.brakeSlots;
        brakeFloor = eq;
      }
      const braked = now < brakeUntil;
      let free = Number(state.freeCashLamports()) / LAMPORTS;
      let slotsLeft = state.hello.caps.max_open_positions - state.committedPositionCount();
      let mainLeft = k.maxMain - open.size;
      let exposure = 0;
      for (const [mint, h] of open) {
        exposure += Math.max(h.invested, Number(state.positions.get(mint)?.cost_lamports ?? 0n) / LAMPORTS);
      }
      for (const mint of touched) {
        if (braked) break;
        if (orders.length >= cap) break;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        if (pendingByMint.has(mint) || probes.has(mint)) continue;
        const t = tapes.get(mint)!;
        const h = open.get(mint);
        const price = Number(curve.virtual_quote_reserves) / Number(curve.virtual_token_reserves);
        const rqSol = Number(curve.real_quote_reserves) / LAMPORTS;
        let want: number;
        if (h === undefined) {
          if (slotsLeft <= 0 || mainLeft <= 0) continue;
          if (t.entries >= k.maxEntries || now - t.lastExit < k.cooldownSlots) continue;
          if (!surgeOk(t, now, rqSol)) continue;
          want = k.firstBuySol;
        } else {
          if (h.exiting || !h.filled || h.adds >= 1) continue;
          if (h.invested >= k.maxPerCoinSol - k.minBuySol) continue;
          const pos = state.positions.get(mint);
          if (pos === undefined) continue;
          if (price < h.lastAddPrice * (1 + k.addStep)) continue;
          if (h.lastValue < (Number(pos.cost_lamports) / LAMPORTS) * (1 + k.addIfUp)) continue;
          if (flow(t, now, k.window) < k.minNetSol) continue;
          if (rqSol > k.maxRqSol) continue;
          want = Math.min(k.addBuySol, k.maxPerCoinSol - h.invested);
        }
        const capSol = Number(state.maxBuyLamports(mint)) / LAMPORTS;
        let amount = Math.min(capSol, want, k.maxExposureSol - exposure);
        if (amount > free - tx) amount = free - tx;
        if (amount < k.minBuySol) continue;
        const lamports = BigInt(Math.floor(amount * LAMPORTS));
        orders.push({ side: 'buy', mint, quote_lamports: lamports, max_slippage_bps: k.buySlipBps });
        free -= amount + tx;
        exposure += amount;
        if (h === undefined) {
          open.set(mint, {
            opened: now,
            peakValue: 0,
            invested: amount,
            exiting: false,
            filled: false,
            lastAddPrice: price,
            lastValue: 0,
            adds: 0,
          });
          t.entries++;
          slotsLeft--;
          mainLeft--;
        } else {
          h.invested += amount;
          h.lastAddPrice = price;
          h.adds++;
        }
      }

      // 4. Guardrail pacing: tiny probe round trips when fills or coins lag the pace.
      if (probes.size < k.maxProbes && slotsLeft > 0 && firstTime !== null && lastTime !== null) {
        const pace = Math.min(1, (lastTime - firstTime) / k.paceSecs);
        const needCoins = myCoins.size < Math.ceil(k.targetCoins * pace);
        const needFills = myFills < Math.ceil(k.targetFills * pace);
        if (needCoins || needFills) {
          const minRq = (k.probeSol * 10_000) / state.hello.caps.max_order_bps_of_real_reserve;
          for (const mint of touched) {
            if (orders.length >= cap || probes.size >= k.maxProbes) break;
            if (open.has(mint) || probes.has(mint) || pendingByMint.has(mint) || state.positions.has(mint)) continue;
            if (needCoins && !needFills && myCoins.has(mint)) continue;
            const curve = state.curves.get(mint);
            if (curve === undefined || curve.complete) continue;
            if (Number(curve.real_quote_reserves) / LAMPORTS < minRq * 1.5) continue;
            if (free < k.probeSol + 2 * tx) break;
            orders.push({ side: 'buy', mint, quote_lamports: BigInt(Math.floor(k.probeSol * LAMPORTS)), max_slippage_bps: k.buySlipBps });
            probes.set(mint, false);
            free -= k.probeSol + tx;
          }
        }
      }
      return orders;
    },
  };
}
