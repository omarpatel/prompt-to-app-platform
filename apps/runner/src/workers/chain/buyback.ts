import { Worker, type Job } from "bullmq";
import type { Logger } from "pino";
import { big, dec, prisma, type AppgenBurn } from "@appgen/db";
import { LAUNCH_PHASE, MIN_BUYBACK_USD, weiFromUsdMicros } from "@appgen/shared";
import {
  attestBurn,
  attestationHash,
  burnTokens,
  curveBuy,
  curveQuoteBuy,
  getErc20Balance,
  getEthBalance,
  getEthPriceUsd,
  publicClient,
  readLaunch,
  tokenAbi,
  treasury,
  v4QuoteExactIn,
  v4SwapExactIn,
  type LaunchRecord,
} from "@appgen/chain";
import type { Address, Hash, Hex, PrivateKeyAccount } from "viem";
import { audit } from "../../lib/audit.js";
import { withLock } from "../../lib/lock.js";
import { CHAIN_QUEUES, type ChainWorkerContext } from "./context.js";
import { chainWorkerEnv } from "./env.js";
import { isPaused } from "./money.js";
import { TREASURY_FLOOR_WEI } from "./wallet.js";
import { runCoinBurns } from "./coinBurn.js";

export const MIN_BUYBACK_MICROS = BigInt(MIN_BUYBACK_USD) * 1_000_000n;
const LOCK_TTL_SECONDS = 900;
/** Quoted output may move between quote and fill; the fill must deliver at least this share of it. */
const SLIPPAGE_BPS = 100n;

export interface BuyResult {
  hash: Hash;
  tokensOut: bigint;
  /** Wei actually consumed (a clamped final curve buy refunds the rest). */
  spentWei: bigint;
}

/**
 * Buys `wei` worth of the launch token to the treasury on whichever venue the launch is trading
 * on: the bonding curve before graduation, the Uniswap v4 pool after. Phases 1 (curve swept,
 * pool not yet live) and 3 (rescued) have no market and throw.
 */
export async function buyTokens(launch: LaunchRecord, wei: bigint, minOutOf: (quoted: bigint) => bigint = (q) => (q * (10_000n - SLIPPAGE_BPS)) / 10_000n): Promise<BuyResult> {
  const t = treasury();
  if (launch.phase === LAUNCH_PHASE.CURVE) {
    const quote = await curveQuoteBuy(launch.curve, wei, t.address);
    if (quote.tokensOut <= 0n) throw new Error(`curve ${launch.curve} quotes 0 tokens for ${wei} wei`);
    const buy = await curveBuy(t.account, launch.curve, wei, minOutOf(quote.tokensOut), t.address);
    return { hash: buy.hash, tokensOut: buy.tokensOut, spentWei: wei - buy.refundWei };
  }
  if (launch.phase === LAUNCH_PHASE.POOL) {
    const quoted = await v4QuoteExactIn(launch, { ethIn: wei });
    if (quoted <= 0n) throw new Error(`v4 pool ${launch.poolId} quotes 0 tokens for ${wei} wei`);
    const swap = await v4SwapExactIn(t.account, launch, { ethIn: wei }, minOutOf(quoted), t.address);
    return { hash: swap.hash, tokensOut: swap.out, spentWei: wei };
  }
  throw new Error(`launch ${launch.token} is in phase ${launch.phase}; no venue to buy on`);
}

const tradable = (launch: LaunchRecord): boolean => launch.phase === LAUNCH_PHASE.CURVE || launch.phase === LAUNCH_PHASE.POOL;

/** `totalSupply()` — the burn proof is its delta across `token.burn()`. */
const totalSupply = (token: Address): Promise<bigint> => publicClient().readContract({ address: token, abi: tokenAbi, functionName: "totalSupply" });

/**
 * $APPGEN's buy-and-burn. The `APPGEN_TOKEN` ledger account holds the 25% APPGEN leg of the legacy
 * Robinhood Chain coins' creator fees that is not routed to APPGEN refunds (fees from before the
 * refund program, and every fee once all snapshot holders are settled; `recordCreatorFee`); once
 * it clears the buyback minimum the treasury buys $APPGEN on its curve/pool and burns it. One
 * `AppgenBurn` row walks PENDING → SWAPPING → SWAPPED → BURNED with every irreversible step
 * persisted before the next, so a crash between the buy and the burn resumes at the burn instead
 * of stranding bought $APPGEN in the treasury (where it is indistinguishable from staked custody).
 * The ledger debit is written with the PENDING row (a crash after the debit under-burns; the
 * reverse would over-spend) and the attestation hashes the credit rows it consumed.
 */
export async function runAppgenBuyback(log: Logger): Promise<void> {
  const token = chainWorkerEnv().APPGEN_TOKEN;
  if (!token) return;
  // A row stuck in SWAPPING is ambiguous: the buy may or may not have landed. Never re-buy it.
  const swapping = await prisma.appgenBurn.findFirst({ where: { status: "SWAPPING" }, orderBy: { createdAt: "asc" } });
  if (swapping) {
    log.warn({ appgenBurnId: swapping.id }, "$APPGEN burn stuck in SWAPPING; buy outcome unknown, needs manual reconcile, skipping");
    if (!swapping.error) await prisma.appgenBurn.update({ where: { id: swapping.id }, data: { error: "interrupted mid-buy; on-chain outcome unknown, manual reconcile required" } });
    return;
  }
  const t = treasury();
  // Resume: bought but not yet burned/attested/settled.
  const swapped = await prisma.appgenBurn.findFirst({ where: { status: "SWAPPED" }, orderBy: { createdAt: "asc" } });
  if (swapped) {
    try {
      await appgenBurnStage(t.account, token, swapped, log);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error({ err, appgenBurnId: swapped.id }, "$APPGEN burn stage failed; will retry next cycle");
      await prisma.appgenBurn.update({ where: { id: swapped.id }, data: { error: message.slice(0, 500) } });
      return;
    }
  }
  const launch = await readLaunch(token);
  if (!launch.exists || !tradable(launch)) {
    log.warn({ token, phase: launch.phase }, "$APPGEN has no market in this phase; buyback deferred");
    return;
  }
  const row = (await prisma.appgenBurn.findFirst({ where: { status: "PENDING" }, orderBy: { createdAt: "asc" } })) ?? (await openAppgenBurn(log));
  if (!row) return;
  const ethWei = big(row.ethWei);
  const treasuryWei = await getEthBalance(t.address);
  if (treasuryWei - ethWei < TREASURY_FLOOR_WEI) {
    log.warn({ appgenBurnId: row.id, treasuryWei: treasuryWei.toString(), ethWei: ethWei.toString() }, "treasury ETH too low for the $APPGEN buyback; left PENDING");
    return;
  }
  // CAS PENDING → SWAPPING claims the buy; past this point the buy may have broadcast.
  const claimed = await prisma.appgenBurn.updateMany({ where: { id: row.id, status: "PENDING" }, data: { status: "SWAPPING" } });
  if (claimed.count !== 1) return;
  let buy: BuyResult;
  try {
    buy = await buyTokens(launch, ethWei);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err, appgenBurnId: row.id }, "$APPGEN buy failed after claim; it may have broadcast, leaving SWAPPING for manual reconcile");
    await prisma.appgenBurn.update({ where: { id: row.id }, data: { error: message.slice(0, 500) } }).catch((e) => log.error({ err: e, appgenBurnId: row.id }, "failed to persist $APPGEN buy error"));
    return;
  }
  log.info({ appgenBurnId: row.id, swapTx: buy.hash, tokensBought: buy.tokensOut.toString(), spentWei: buy.spentWei.toString() }, "$APPGEN bought");
  let swappedRow: AppgenBurn;
  try {
    swappedRow = await prisma.appgenBurn.update({
      where: { id: row.id },
      data: { status: "SWAPPED", swapTx: buy.hash, tokensBought: dec(buy.tokensOut), ethWei: dec(buy.spentWei), error: null },
    });
  } catch (err) {
    log.error({ err, appgenBurnId: row.id, swapTx: buy.hash }, "$APPGEN buy landed but recording SWAPPED failed; left SWAPPING for manual reconcile");
    return;
  }
  try {
    await appgenBurnStage(t.account, token, swappedRow, log);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err, appgenBurnId: row.id }, "$APPGEN burn stage failed; will retry next cycle");
    await prisma.appgenBurn.update({ where: { id: row.id }, data: { error: message.slice(0, 500) } });
  }
}

/**
 * Opens the PENDING $APPGEN burn for the whole `APPGEN_TOKEN` balance and debits the ledger in the
 * same transaction. Null below the buyback minimum.
 */
async function openAppgenBurn(log: Logger): Promise<AppgenBurn | null> {
  const balance = await prisma.ledgerEntry.aggregate({ where: { account: "APPGEN_TOKEN" }, _sum: { deltaMicros: true } });
  const pending = balance._sum.deltaMicros ?? 0n;
  if (pending < MIN_BUYBACK_MICROS) return null;
  const lastDebit = await prisma.ledgerEntry.findFirst({ where: { account: "APPGEN_TOKEN", refType: "AppgenBurn" }, orderBy: { createdAt: "desc" }, select: { createdAt: true } });
  const consumed = await prisma.ledgerEntry.findMany({
    where: { account: "APPGEN_TOKEN", deltaMicros: { gt: 0n }, ...(lastDebit ? { createdAt: { gt: lastDebit.createdAt } } : {}) },
    select: { id: true },
  });
  const ethWei = weiFromUsdMicros(pending, await getEthPriceUsd());
  const row = await prisma.$transaction(async (tx) => {
    const created = await tx.appgenBurn.create({ data: { status: "PENDING", usdMicros: pending, ethWei: dec(ethWei), attestHash: attestationHash(consumed.map((e) => e.id)) } });
    await tx.ledgerEntry.create({ data: { account: "APPGEN_TOKEN", deltaMicros: -pending, refType: "AppgenBurn", refId: created.id, memo: "$APPGEN buyback" } });
    return created;
  });
  log.info({ appgenBurnId: row.id, usdMicros: pending.toString(), ethWei: ethWei.toString(), consumed: consumed.length }, "$APPGEN burn opened");
  return row;
}

/**
 * SWAPPED → BURNED: burn exactly what was bought (the treasury also custodies staked $APPGEN, so a
 * "burn whatever is held" clamp would be theft here), attest, settle. Each step is persisted
 * before the next so a retry never repeats an irreversible transaction.
 */
async function appgenBurnStage(account: PrivateKeyAccount, token: Address, burn: AppgenBurn, log: Logger): Promise<void> {
  let row = burn;
  if (!row.burnTx) {
    const amount = big(row.tokensBought);
    if (amount <= 0n) throw new Error("no $APPGEN recorded as bought; nothing to burn");
    const held = await getErc20Balance(token, account.address);
    if (held < amount) throw new Error(`treasury holds ${held} $APPGEN units, fewer than the ${amount} bought; refusing to burn staked custody`);
    const before = await totalSupply(token);
    const burnTx = await burnTokens(account, token, amount);
    const after = await totalSupply(token);
    row = await prisma.appgenBurn.update({ where: { id: row.id }, data: { burnTx, tokensBurned: dec(amount), burnedUnits: dec(before - after), error: null } });
    log.info({ appgenBurnId: row.id, burnTx, amount: amount.toString(), burnedUnits: (before - after).toString() }, "$APPGEN burned");
  }
  if (!row.attestTx) {
    const attestTx = await attestBurn(account, row.attestHash as Hex);
    row = await prisma.appgenBurn.update({ where: { id: row.id }, data: { attestTx } });
    log.info({ appgenBurnId: row.id, attestTx }, "$APPGEN burn attested");
  }
  row = await prisma.appgenBurn.update({ where: { id: row.id }, data: { status: "BURNED", completedAt: new Date(), error: null } });
  await audit({
    actor: "worker:buyback",
    action: "APPGEN_BURN",
    targetType: "AppgenBurn",
    targetId: row.id,
    meta: {
      token,
      usdMicros: row.usdMicros,
      ethWei: big(row.ethWei),
      tokensBought: big(row.tokensBought),
      burnedUnits: big(row.burnedUnits),
      swapTx: row.swapTx,
      burnTx: row.burnTx,
      attestTx: row.attestTx,
      attestHash: row.attestHash,
    },
  });
  log.info({ appgenBurnId: row.id, usdMicros: row.usdMicros.toString(), ethWei: big(row.ethWei).toString(), burnedUnits: big(row.burnedUnits).toString(), swapTx: row.swapTx, burnTx: row.burnTx, attestTx: row.attestTx }, "$APPGEN bought and burned");
}

export async function runBuybackJob(ctx: ChainWorkerContext, job: Job): Promise<void> {
  const log = ctx.log.child({ worker: "buyback", jobId: job.id });
  if (await isPaused("pauseBuyback")) {
    log.info("paused via PlatformSetting.pauseBuyback");
    return;
  }
  const held = await withLock(ctx.redis, "lock:buyback:appgen", LOCK_TTL_SECONDS, async () => {
    try {
      await runAppgenBuyback(log);
    } catch (err) {
      log.error({ err }, "$APPGEN buyback failed");
    }
    // Coin burns: the same 25% leg on chains where APPGEN cannot be bought, one machine per app.
    await runCoinBurns(log);
  });
  if (!held.acquired) log.info("$APPGEN buyback already in progress; skipping");
}

export function createBuybackWorker(ctx: ChainWorkerContext, connection: ChainWorkerContext["redis"]): Worker {
  return new Worker(CHAIN_QUEUES.buyback, (job) => runBuybackJob(ctx, job), { connection, concurrency: 1 });
}
