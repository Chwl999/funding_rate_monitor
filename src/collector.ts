import { format } from 'date-fns';
import { CONFIG, EXCHANGES } from './config';
import { logger } from './utils';

interface FundingRate {
  rate: number;
  apr: number;
  dailyApr: number; // 新增日化收益率
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
    const { apr, dailyApr } = calculateRates(rate);
    this.fundingRates[exchange][symbol] = {
      rate,
      apr,
      dailyApr, // 存储日化收益率
      timestamp: new Date(),
    };
    logger.info(
      `更新 ${exchange} 的资金费率: ${symbol} -> ${rate} (APR: ${apr.toFixed(2)}%, Daily APR: ${dailyApr.toFixed(2)}%)`
    );
  }

  getArbitragePairs(): string {
    const positivePairs: [string, string, number, number][] = []; // 添加 dailyApr
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

    positivePairs.sort((a, b) => b[2] - a[2]); // 按年化收益率排序
    negativePairs.sort((a, b) => a[2] - b[2]);

    let message = `资金费率更新 (${format(new Date(), 'yyyy-MM-dd HH:mm:ss')})\n\n`;
    message += `正向套利机会 (年化收益率 ≥ ${this.minPositiveApr}%):\n`;
    if (positivePairs.length) {
      message += `交易所 | 交易对           | 年化收益率 | 日化收益率\n`;
      message += positivePairs
        .map(([ex, sym, apr, dailyApr]) =>
          `${ex.padEnd(10)} | ${sym.padEnd(15)} | ${apr.toFixed(2)}% | ${dailyApr.toFixed(2)}%`
        )
        .join('\n');
    } else {
      message += '无正向套利机会\n';
    }

    message += `\n反向套利机会 (年化收益率 ≤ ${this.minNegativeApr}%):\n`;
    if (negativePairs.length) {
      message += `交易所 | 交易对           | 年化收益率 | 日化收益率\n`;
      message += negativePairs
        .map(([ex, sym, apr, dailyApr]) =>
          `${ex.padEnd(10)} | ${sym.padEnd(15)} | ${apr.toFixed(2)}% | ${dailyApr.toFixed(2)}%`
        )
        .join('\n');
    } else {
      message += '无反向套利机会\n';
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

export function calculateRates(fundingRate: number): { apr: number; dailyApr: number } {
  const dailyApr = fundingRate * 3 * 100; // 日化收益率：每天3次结算
  const apr = dailyApr * 365; // 年化收益率
  return { apr, dailyApr };
}