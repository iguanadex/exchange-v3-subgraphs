/* eslint-disable prefer-const */
import { ONE_BD, ZERO_BD, ZERO_BI } from './constants'
import { Bundle, Pool, Token } from '../generated/schema'
import { BigDecimal, BigInt } from '@graphprotocol/graph-ts'
import { exponentToBigDecimal, safeDiv } from './index'
import { getOrLoadToken } from './entity'

// prettier-ignore
const WETH_ADDRESS = '0xc9b53ab2679f573e480d01e0f49e2b5cfb7a3eab' // WXTZ
// prettier-ignore
const USDC_WETH_03_POOL = '0x508060a01f11d6a2eb774b55aeba95931265e0cc' // USDC/WXTZ pool

const STABLE_IS_TOKEN0 = 'true' as string

// token where amounts should contribute to tracked volume and liquidity
// usually tokens that many tokens are paired with s
// prettier-ignore
export const WHITELIST_TOKENS: string[] = [
  "0xc9b53ab2679f573e480d01e0f49e2b5cfb7a3eab", // WXTZ
  "0x2c03058c8afc06713be23e58d2febc8337dbfe6a", // USDT
  "0x796ea11fa2dd751ed01b53c372ffdb4aaa8f00f9", // USDC
  "0xbfc94cd2b1e55999cfc7347a9313e88702b83d0f", // WBTC
  "0xfc24f770f94edbca6d6f885e12d4317320bcb401", // WETH
  "0xaa40a1cc1561c584b675cbd12f1423a32e2a0d8c", // WBNB
  "0xe820995cd39b6e09eaa7e4e16337184b4a61b644", // WAVAX
  "0xbbd1f50a212357067318a84179892684e1ac5181", // SHIB
];
// export let WHITELIST_TOKENS: string[] = '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c,0x55d398326f99059ff775485246999027b3197955,0xe9e7cea3dedca5984780bafc599bd69add087d56,0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d,0x7130d2a12b9bcbfae4f2634d864a1ee1ce3ead9c,0x2170ed0880ac9a755fd29b2688956bd959f933f8,0x0e09fabb73bd3ade0a17ecc321fd13a19e81ce82'.split(',')

// prettier-ignore
const STABLE_COINS: string[] = [
  // Mainnet
  "0x2c03058c8afc06713be23e58d2febc8337dbfe6a", // USDT
  "0x796ea11fa2dd751ed01b53c372ffdb4aaa8f00f9", // USDC
];
// let STABLE_COINS: string[] = '0x55d398326f99059ff775485246999027b3197955,0xe9e7cea3dedca5984780bafc599bd69add087d56,0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d'.split(',')

let MINIMUM_ETH_LOCKED = BigDecimal.fromString('5')

let Q192 = BigInt.fromI32(2).pow(192)  // Ensure safe calculation of 2^192 using BigInt
export function sqrtPriceX96ToTokenPrices(sqrtPriceX96: BigInt, token0: Token, token1: Token): BigDecimal[] {
  let num = sqrtPriceX96.times(sqrtPriceX96).toBigDecimal()
  let denom = BigDecimal.fromString(Q192.toString())
  let price1 = num.div(denom).times(exponentToBigDecimal(token0.decimals)).div(exponentToBigDecimal(token1.decimals))

  let price0 = safeDiv(BigDecimal.fromString('1'), price1)
  return [price0, price1]
}

export function getEthPriceInUSD(): BigDecimal {
  // fetch eth prices for each stablecoin
  let usdcPool = Pool.load(USDC_WETH_03_POOL) // dai is token0
  if (usdcPool !== null) {
    if (STABLE_IS_TOKEN0 === 'true') {
      return usdcPool.token0Price
    }
    return usdcPool.token1Price
  }
  return ZERO_BD
}

/**
 * Search through graph to find derived Eth per token.
 * @todo update to be derived ETH (add stablecoin estimates)
 **/
export function findEthPerToken(bundle: Bundle, token: Token): BigDecimal {
  if (token.id == WETH_ADDRESS) {
    return ONE_BD
  }
  let whiteList = token.whitelistPools
  // for now just take USD from pool with greatest TVL
  // need to update this to actually detect best rate based on liquidity distribution
  let largestLiquidityETH = ZERO_BD
  let priceSoFar = ZERO_BD

  // hardcoded fix for incorrect rates
  // if whitelist includes token - get the safe price
  if (STABLE_COINS.includes(token.id)) {
    priceSoFar = safeDiv(ONE_BD, bundle.ethPriceUSD)
  } else {
    for (let i = 0; i < whiteList.length; ++i) {
      let poolAddress = whiteList[i]
      let pool = Pool.load(poolAddress)
      if (pool === null) {
        continue
      }

      if (pool.liquidity.gt(ZERO_BI)) {
        if (pool.token0 == token.id) {
          // whitelist token is token1
          let token1 = getOrLoadToken(pool.token1)
          // get the derived ETH in pool
          let ethLocked = pool.totalValueLockedToken1.times(token1.derivedETH)
          if (
            ethLocked.gt(largestLiquidityETH) &&
            (ethLocked.gt(MINIMUM_ETH_LOCKED) || WHITELIST_TOKENS.includes(pool.token0))
          ) {
            largestLiquidityETH = ethLocked
            // token1 per our token * Eth per token1
            priceSoFar = pool.token1Price.times(token1.derivedETH as BigDecimal)
          }
        }
        if (pool.token1 == token.id) {
          let token0 = getOrLoadToken(pool.token0)
          // get the derived ETH in pool
          let ethLocked = pool.totalValueLockedToken0.times(token0.derivedETH)
          if (
            ethLocked.gt(largestLiquidityETH) &&
            (ethLocked.gt(MINIMUM_ETH_LOCKED) || WHITELIST_TOKENS.includes(pool.token1))
          ) {
            largestLiquidityETH = ethLocked
            // token0 per our token * ETH per token0
            priceSoFar = pool.token0Price.times(token0.derivedETH as BigDecimal)
          }
        }
      }
    }
  }
  return priceSoFar // nothing was found return 0
}

/**
 * Accepts tokens and amounts, return tracked amount based on token whitelist
 * If one token on whitelist, return amount in that token converted to USD * 2.
 * If both are, return sum of two amounts
 * If neither is, return 0
 */
export function getTrackedAmountUSD(
  tokenAmount0: BigDecimal,
  token0: Token,
  tokenAmount1: BigDecimal,
  token1: Token,
): BigDecimal {
  let bundle = Bundle.load('1')
  let price0USD = token0.derivedETH.times(bundle.ethPriceUSD)
  let price1USD = token1.derivedETH.times(bundle.ethPriceUSD)

  // both are whitelist tokens, return sum of both amounts
  if (WHITELIST_TOKENS.includes(token0.id) && WHITELIST_TOKENS.includes(token1.id)) {
    return tokenAmount0.times(price0USD).plus(tokenAmount1.times(price1USD))
  }

  // take double value of the whitelisted token amount
  if (WHITELIST_TOKENS.includes(token0.id) && !WHITELIST_TOKENS.includes(token1.id)) {
    return tokenAmount0.times(price0USD).times(BigDecimal.fromString('2'))
  }

  // take double value of the whitelisted token amount
  if (!WHITELIST_TOKENS.includes(token0.id) && WHITELIST_TOKENS.includes(token1.id)) {
    return tokenAmount1.times(price1USD).times(BigDecimal.fromString('2'))
  }

  // neither token is on white list, tracked amount is 0
  return ZERO_BD
}

/**
 * Accepts tokens and amounts, return tracked amount based on token whitelist
 * If one token on whitelist, return amount in that token converted to USD * 2.
 * If both are, return sum of two amounts
 * If neither is, return 0
 */
export function getTrackedAmountETH(
  tokenAmount0: BigDecimal,
  token0: Token,
  tokenAmount1: BigDecimal,
  token1: Token,
): BigDecimal {
  let derivedETH0 = token0.derivedETH
  let derivedETH1 = token1.derivedETH

  // both are whitelist tokens, return sum of both amounts
  if (WHITELIST_TOKENS.includes(token0.id) && WHITELIST_TOKENS.includes(token1.id)) {
    return tokenAmount0.times(derivedETH0).plus(tokenAmount1.times(derivedETH1))
  }

  // take double value of the whitelisted token amount
  if (WHITELIST_TOKENS.includes(token0.id) && !WHITELIST_TOKENS.includes(token1.id)) {
    return tokenAmount0.times(derivedETH0).times(BigDecimal.fromString('2'))
  }

  // take double value of the whitelisted token amount
  if (!WHITELIST_TOKENS.includes(token0.id) && WHITELIST_TOKENS.includes(token1.id)) {
    return tokenAmount1.times(derivedETH1).times(BigDecimal.fromString('2'))
  }

  // neither token is on white list, tracked amount is 0
  return ZERO_BD
}

export class AmountType {
  eth: BigDecimal
  usd: BigDecimal
  ethUntracked: BigDecimal
  usdUntracked: BigDecimal
}

export function getAdjustedAmounts(
  bundle: Bundle,
  tokenAmount0: BigDecimal,
  token0: Token,
  tokenAmount1: BigDecimal,
  token1: Token,
): AmountType {
  let derivedETH0 = token0.derivedETH
  let derivedETH1 = token1.derivedETH

  let eth = ZERO_BD
  let ethUntracked = tokenAmount0.times(derivedETH0).plus(tokenAmount1.times(derivedETH1))

  // both are whitelist tokens, return sum of both amounts
  if (WHITELIST_TOKENS.includes(token0.id) && WHITELIST_TOKENS.includes(token1.id)) {
    eth = ethUntracked
  }

  // take double value of the whitelisted token amount
  if (WHITELIST_TOKENS.includes(token0.id) && !WHITELIST_TOKENS.includes(token1.id)) {
    eth = tokenAmount0.times(derivedETH0).times(BigDecimal.fromString('2'))
  }

  // take double value of the whitelisted token amount
  if (!WHITELIST_TOKENS.includes(token0.id) && WHITELIST_TOKENS.includes(token1.id)) {
    eth = tokenAmount1.times(derivedETH1).times(BigDecimal.fromString('2'))
  }

  // Define USD values based on ETH derived values.
  let usd = eth.times(bundle.ethPriceUSD)
  let usdUntracked = ethUntracked.times(bundle.ethPriceUSD)

  return { eth, usd, ethUntracked, usdUntracked }
}
