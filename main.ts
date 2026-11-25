// SteadyClipper — Sharpe-first paper bot for the pump.fun replay.
// See strategy.ts for the full design: small quick momentum scalps, tight exits,
// steady flow across the window. This file only wires the strategy to the harness.
import { runBot } from './vendor/makefun-bot.ts';
import { createBot } from './strategy.ts';

await runBot(createBot());
