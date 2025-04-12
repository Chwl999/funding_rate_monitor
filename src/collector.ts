import { format } from 'date-fns';
import { CONFIG, EXCHANGES, TRANSACTION_FEE_PERCENT } from './config';
import { logger } from './utils';

interface FundingRate {
  rate: number; // 原始费率
  apr: number; // 原始年化 (用于筛选)
  singleCycleNetRatePercent: number; // 单次净收益率 (%)
  dailyNetRatePercent: number; // 单日净收益率 (%)
  timestamp: Date;
}

export class FundingRateCollector {
  private fundingRates: { [exchange: string]: { [symbol: string]: FundingRate } };
  private minPositiveApr: number;
  private minNegativeApr: number;

  constructor() {
    this.fundingRates = Object.keys(EXCHANGES).reduce((acc, name) => {
      acc[name] = {};
      return acc;
    }, {} as { [key: string]: { [key: string]: FundingRate } });
    this.minPositiveApr = CONFIG.thresholds.min_positive_apr;
    this.minNegativeApr = CONFIG.thresholds.min_negative_apr;
  }

  updateRate(exchange: string, symbol: string, rate: number): void {
    const { apr, singleCycleNetRatePercent, dailyNetRatePercent } = calculateRates(rate, TRANSACTION_FEE_PERCENT);
    this.fundingRates[exchange][symbol] = {
      rate,
      apr, // 存储原始 APR
      singleCycleNetRatePercent, // 存储单次净收益率
      dailyNetRatePercent, // 存储单日净收益率
      timestamp: new Date(),
    };
    // logger.info(
    //   `更新 ${exchange} 的资金费率: ${symbol} -> ${rate} (APR: ${apr.toFixed(2)}%, SingleNet: ${singleCycleNetRatePercent.toFixed(4)}%, DailyNet: ${dailyNetRatePercent.toFixed(4)}%)`
    // );
  }

  getArbitragePairs(): string {
    const positivePairs: [string, string, number, number, number][] = []; // [exchange, symbol, apr, singleCycleNetRate, dailyNetRate]
    const negativePairs: [string, string, number, number, number][] = []; // [exchange, symbol, apr, singleCycleNetRate, dailyNetRate]

    for (const exchangeName in this.fundingRates) {
      for (const [symbol, rateData] of Object.entries(this.fundingRates[exchangeName])) {
        // 筛选仍然基于原始 APR
        if (rateData.apr >= this.minPositiveApr) {
          positivePairs.push([exchangeName, symbol, rateData.apr, rateData.singleCycleNetRatePercent, rateData.dailyNetRatePercent]);
        } else if (rateData.apr <= this.minNegativeApr) {
          negativePairs.push([exchangeName, symbol, rateData.apr, rateData.singleCycleNetRatePercent, rateData.dailyNetRatePercent]);
        }
      }
    }

    // 排序依据仍然是原始 APR
    positivePairs.sort((a, b) => b[2] - a[2]);
    negativePairs.sort((a, b) => a[2] - b[2]);

    // 去除交易对后缀
    const cleanSymbol = (symbol: string): string => {
      return symbol
        .replace(/(_USDT|USDT)$/, '')   // Binance: BTCUSDT -> BTC Gate: BTCUSDT -> BTC
        .replace(/-USDT-SWAP$/, '');    // OKX: BTC-USDT-SWAP -> BTC
    };

    let message = `📊 **资金费率更新 (${format(new Date(), 'yyyy-MM-dd HH:mm:ss')})**\n\n`;
    message += `🚀 **正向套利机会 (年化 ≥ ${this.minPositiveApr}%)**\n`;
    if (positivePairs.length) {
      message += positivePairs
        .map(([ex, sym, _apr, singleCycleNetRate, dailyNetRate]) =>
          `- ${ex} | ${cleanSymbol(sym)} | 单次: ${singleCycleNetRate.toFixed(4)}% | 单日: ${dailyNetRate.toFixed(4)}%`
        )
        .join('\n');
    } else {
      message += '  暂无显著正向套利机会\n';
    }

    message += `\n\n📉 **反向套利机会 (年化 ≤ ${this.minNegativeApr}%)**\n`;
    if (negativePairs.length) {
      message += negativePairs
        .map(([ex, sym, _apr, singleCycleNetRate, dailyNetRate]) =>
          `- ${ex} | ${cleanSymbol(sym)} | 单次: ${singleCycleNetRate.toFixed(4)}% | 单日: ${dailyNetRate.toFixed(4)}%`
        )
        .join('\n');
    } else {
      message += '  暂无显著反向套利机会\n';
    }

    return message;
  }

  clear(): void {
    this.fundingRates = Object.keys(EXCHANGES).reduce((acc, name) => {
      acc[name] = {};
      return acc;
    }, {} as { [key: string]: { [key: string]: FundingRate } });
  }
}

// 计算原始年化(筛选用), 单次净收益率(显示用), 单日净收益率(显示用)
export function calculateRates(fundingRate: number, feePercent: number): { apr: number; singleCycleNetRatePercent: number; dailyNetRatePercent: number } {
  // 1. 计算原始 APR (用于筛选)
  const rawApr = fundingRate * 3 * 365 * 100;

  // 2. 计算单次净收益率 (显示用, %)
  const fundingRatePercent = fundingRate * 100;
  const singleCycleNetRatePercent = fundingRatePercent - feePercent;

  // 3. 计算单日净收益率 (显示用, %)
  const dailyFundingRatePercent = fundingRate * 3 * 100;
  let dailyNetRatePercent: number;
  if (fundingRate >= 0) {
    // 正向: 每日费率 - 总手续费
    dailyNetRatePercent = dailyFundingRatePercent - feePercent;
  } else {
    // 反向: 每日费率 + 总手续费 (按用户要求)
    dailyNetRatePercent = dailyFundingRatePercent + feePercent;
  }

  return { apr: rawApr, singleCycleNetRatePercent, dailyNetRatePercent };
}