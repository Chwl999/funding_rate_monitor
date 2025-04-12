import { format } from 'date-fns';
import { CONFIG, EXCHANGES, TRANSACTION_FEE_PERCENT } from './config';
import { logger } from './utils';

interface FundingRate {
  rate: number;
  apr: number;
  dailyApr: number;
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
    const { apr, dailyApr } = calculateRates(rate, TRANSACTION_FEE_PERCENT);
    this.fundingRates[exchange][symbol] = {
      rate,
      apr,
      dailyApr,
      timestamp: new Date(),
    };
    // logger.info(
    //   `更新 ${exchange} 的资金费率: ${symbol} -> ${rate} (APR: ${apr.toFixed(2)}%, Daily APR: ${dailyApr.toFixed(2)}%)`
    // );
  }

  getArbitragePairs(): string {
    const positivePairs: [string, string, number, number][] = [];
    const negativePairs: [string, string, number, number][] = [];

    for (const exchangeName in this.fundingRates) {
      for (const [symbol, rateData] of Object.entries(this.fundingRates[exchangeName])) {
        if (rateData.apr >= this.minPositiveApr) {
          positivePairs.push([exchangeName, symbol, rateData.apr, rateData.dailyApr]);
        } else if (rateData.apr <= this.minNegativeApr) {
          negativePairs.push([exchangeName, symbol, rateData.apr, rateData.dailyApr]);
        }
      }
    }

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
        .map(([ex, sym, apr, dailyApr]) =>
          `${ex}, 交易对: ${cleanSymbol(sym)}, 年化: ${apr.toFixed(2)}%, 日化: ${dailyApr.toFixed(2)}%`
        )
        .join('\n');
    } else {
      message += '  暂无显著正向套利机会\n';
    }

    message += `\n\n📉 **反向套利机会 (年化 ≤ ${this.minNegativeApr}%)**\n`;
    if (negativePairs.length) {
      message += negativePairs
        .map(([ex, sym, apr, dailyApr]) =>
          `${ex}, 交易对: ${cleanSymbol(sym)}, 年化: ${apr.toFixed(2)}%, 日化: ${dailyApr.toFixed(2)}%`
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

export function calculateRates(fundingRate: number, feePercent: number): { apr: number; dailyApr: number } {
  const rawDailyApr = fundingRate * 3 * 100;
  const rawApr = rawDailyApr * 365;

  // 计算扣除一次性手续费后的净收益率
  // 将手续费从年化中减去，并将分摊到每日的部分从日化中减去
  const dailyFeeDeduction = feePercent / 365;
  const netDailyApr = rawDailyApr - dailyFeeDeduction;
  const netApr = rawApr - feePercent;

  return { apr: netApr, dailyApr: netDailyApr };
}