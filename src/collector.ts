/**
 * @file collector.ts
 * @description 定义了 FundingRateCollector 类，用于收集、存储和处理来自不同交易所的资金费率数据，并提供生成套利机会消息的方法。
 */

import { format } from 'date-fns'; // 导入日期格式化函数
import { CONFIG, EXCHANGES, TRANSACTION_FEE_PERCENT } from './config'; // 导入配置信息，包括交易所配置、阈值和手续费
import { logger } from './utils'; // 导入日志记录器

/**
 * @interface FundingRate
 * @description 定义单个资金费率记录的结构。
 */
interface FundingRate {
  rate: number; // 原始资金费率 (例如 0.0001 代表 0.01%)
  apr: number; // 根据原始费率计算出的粗略年化百分比 (主要用于初步筛选)
  singleCycleNetRatePercent: number; // 单次资金费率结算的净收益率 (%)，已扣除单边手续费
  dailyNetRatePercent: number; // 基于单日结算频率估算的日净收益率 (%)，已扣除单边手续费
  timestamp: Date; // 数据更新的时间戳
}

/**
 * @function cleanSymbol
 * @description 辅助函数，用于标准化不同交易所的交易对名称。
 * 移除常见的后缀，例如 'USDT', '_USDT', '-USDT-SWAP'，只保留基础币种名称 (如 'BTC')。
 * @param symbol - 原始交易对名称 (例如 'BTCUSDT', 'ETH-USDT-SWAP')
 * @returns 标准化后的交易对名称 (例如 'BTC', 'ETH')
 */
const cleanSymbol = (symbol: string): string => {
  return symbol
    .replace(/(_USDT|USDT)$/, '') // 移除结尾的 'USDT' 或 '_USDT' (Binance, Gate)
    .replace(/-USDT-SWAP$/, ''); // 移除结尾的 '-USDT-SWAP' (OKX)
};

/**
 * @class FundingRateCollector
 * @description 资金费率数据收集器类。
 * 负责存储从各个交易所获取的资金费率，并提供方法来识别和格式化套利机会。
 */
export class FundingRateCollector {
  // 使用嵌套对象存储资金费率数据：{ exchangeName: { symbolName: FundingRate } }
  private fundingRates: { [exchange: string]: { [symbol: string]: FundingRate } };
  // 从配置中读取的正向套利 APR 阈值 (%)
  private minPositiveApr: number;
  // 从配置中读取的反向套利 APR 阈值 (%)
  private minNegativeApr: number;

  /**
   * @constructor
   * @description 初始化 FundingRateCollector 实例。
   * 创建空的 fundingRates 对象结构，并从配置加载 APR 阈值。
   */
  constructor() {
    // 根据 EXCHANGES 配置初始化 fundingRates 对象的顶层键 (交易所名称)
    this.fundingRates = Object.keys(EXCHANGES).reduce((acc, name) => {
      acc[name] = {}; // 每个交易所对应一个空的对象，用于存储该交易所的交易对费率
      return acc;
    }, {} as { [key: string]: { [key: string]: FundingRate } });

    // 从全局 CONFIG 对象加载正负 APR 阈值
    this.minPositiveApr = CONFIG.thresholds.min_positive_apr;
    this.minNegativeApr = CONFIG.thresholds.min_negative_apr;
  }

  /**
   * @method updateRate
   * @description 更新或添加指定交易所和交易对的资金费率。
   * 会自动调用 calculateRates 计算相关的衍生费率 (APR, 单次净收益率, 单日净收益率)。
   * @param exchange - 交易所名称 (例如 'binance')
   * @param symbol - 交易对名称 (例如 'BTCUSDT')
   * @param rate - 原始资金费率
   */
  updateRate(exchange: string, symbol: string, rate: number): void {
    // 调用 calculateRates 函数计算各种衍生费率
    const { apr, singleCycleNetRatePercent, dailyNetRatePercent } = calculateRates(rate, TRANSACTION_FEE_PERCENT);
    // 将计算结果和原始费率、时间戳存储到 fundingRates 对象中
    this.fundingRates[exchange][symbol] = {
      rate,
      apr, // 存储计算出的原始 APR
      singleCycleNetRatePercent, // 存储计算出的单次净收益率
      dailyNetRatePercent, // 存储计算出的单日净收益率
      timestamp: new Date(), // 记录当前时间为数据更新时间
    };
    // 可选的日志记录 (当前被注释掉)
    // logger.info(
    //   `更新 ${exchange} 的资金费率: ${symbol} -> ${rate} (APR: ${apr.toFixed(2)}%, SingleNet: ${singleCycleNetRatePercent.toFixed(4)}%, DailyNet: ${dailyNetRatePercent.toFixed(4)}%)`
    // );
  }

  /**
   * @method getArbitragePairs
   * @description 获取常规的单边高费率套利机会 (正向和反向)。
   * 根据配置的 APR 阈值筛选，并按 APR 排序，最后格式化成 Telegram 消息字符串。
   * 显示的是扣除手续费后的净收益率。
   * @returns 格式化后的 Telegram 消息字符串。
   */
  getArbitragePairs(): string {
    // 存储满足条件的正向套利机会: [交易所, 交易对, 原始APR, 单次净收益率, 单日净收益率]
    const positivePairs: [string, string, number, number, number][] = [];
    // 存储满足条件的反向套利机会: [交易所, 交易对, 原始APR, 单次净收益率, 单日净收益率]
    const negativePairs: [string, string, number, number, number][] = [];

    // 遍历所有交易所的费率数据
    for (const exchangeName in this.fundingRates) {
      for (const [symbol, rateData] of Object.entries(this.fundingRates[exchangeName])) {
        // 筛选基于原始 APR (rateData.apr) 是否达到阈值
        if (rateData.apr >= this.minPositiveApr) {
          positivePairs.push([exchangeName, symbol, rateData.apr, rateData.singleCycleNetRatePercent, rateData.dailyNetRatePercent]);
        } else if (rateData.apr <= this.minNegativeApr) {
          negativePairs.push([exchangeName, symbol, rateData.apr, rateData.singleCycleNetRatePercent, rateData.dailyNetRatePercent]);
        }
      }
    }

    // 对找到的机会进行排序，排序依据仍然是原始 APR
    positivePairs.sort((a, b) => b[2] - a[2]); // 正向按 APR 降序
    negativePairs.sort((a, b) => a[2] - b[2]); // 反向按 APR 升序 (即负得越多越靠前)

    // 构建 Telegram 消息字符串
    let message = `📊 **资金费率更新 (${format(new Date(), 'yyyy-MM-dd HH:mm:ss')})**\n\n`; // 消息头，包含时间戳

    // 添加正向套利机会部分
    message += `🚀 **正向套利机会，买入现货，做空合约 (年化 ≥ ${this.minPositiveApr}%)**\n`; // 标题和阈值说明
    if (positivePairs.length) {
      message += positivePairs
        .map(([ex, sym, _apr, singleCycleNetRate, dailyNetRate]) =>
          // 格式化每一条机会：交易所 | 清理后的币种 | 单次净收益 | 单日净收益
          `${ex} | ${cleanSymbol(sym)} | 单次: ${singleCycleNetRate.toFixed(4)}% | 单日: ${dailyNetRate.toFixed(4)}%`
        )
        .join('\n'); // 使用换行符连接
    } else {
      message += '  暂无显著正向套利机会\n'; // 如果没有机会，显示提示信息
    }

    // 添加反向套利机会部分
    message += `\n\n📉 **反向套利机会，借币卖出现货，做多合约 (年化 ≤ ${this.minNegativeApr}%)**\n`; // 标题和阈值说明
    if (negativePairs.length) {
      message += negativePairs
        .map(([ex, sym, _apr, singleCycleNetRate, dailyNetRate]) =>
          // 格式化每一条机会
          `${ex} | ${cleanSymbol(sym)} | 单次: ${singleCycleNetRate.toFixed(4)}% | 单日: ${dailyNetRate.toFixed(4)}%`
        )
        .join('\n');
    } else {
      message += '  暂无显著反向套利机会\n'; // 如果没有机会，显示提示信息
    }

    return message; // 返回最终构建的消息字符串
  }

  /**
   * @method getCrossExchangeArbitrageOpportunities
   * @description 计算并格式化跨交易所的资金费率套利机会。
   * 比较同一币种在不同交易所的费率差，如果差值超过双边手续费，则视为套利机会。
   * @param feePercent - 单边交易手续费率 (%)
   * @returns 格式化后的 Telegram 消息字符串，如果没有机会则返回空字符串。
   */
  getCrossExchangeArbitrageOpportunities(feePercent: number): string {
    // 存储找到的跨交易所套利机会
    const opportunities: {
      longExchange: string; // 做多交易所
      shortExchange: string; // 做空交易所
      cleanedSymbol: string; // 标准化后的币种名称
      netProfitPercent: number; // 净利润率 (%)
    }[] = [];

    // 用于按标准化币种名称聚合费率数据
    const ratesByCleanedSymbol: {
      [cleanedSymbol: string]: { exchange: string; symbol: string; rate: number }[];
    } = {};

    // 步骤 1: 按清理后的币种名称聚合费率数据
    for (const exchange in this.fundingRates) {
      for (const symbol in this.fundingRates[exchange]) {
        const cleaned = cleanSymbol(symbol); // 获取标准化的币种名称
        if (!ratesByCleanedSymbol[cleaned]) {
          ratesByCleanedSymbol[cleaned] = []; // 如果是新的币种，初始化数组
        }
        // 将该交易所的费率信息添加到对应币种的列表中
        ratesByCleanedSymbol[cleaned].push({
          exchange,
          symbol, // 保留原始 symbol，虽然这里没用到，但可能未来有用
          rate: this.fundingRates[exchange][symbol].rate, // 只取原始费率进行比较
        });
      }
    }

    // 计算进行一次跨交易所套利所需的总手续费 (双边)
    const combinedFeePercent = 2 * feePercent;

    // 步骤 2: 查找套利机会
    // 遍历聚合后的数据
    for (const cleanedSym in ratesByCleanedSymbol) {
      const ratesList = ratesByCleanedSymbol[cleanedSym]; // 获取当前币种在各个交易所的费率列表
      // 如果该币种只在一个交易所出现，无法进行跨交易所套利，跳过
      if (ratesList.length < 2) continue;

      // 使用嵌套循环，两两比较不同交易所之间的费率
      for (let i = 0; i < ratesList.length; i++) {
        for (let j = i + 1; j < ratesList.length; j++) {
          const ex1Data = ratesList[i]; // 交易所 1 的数据
          const ex2Data = ratesList[j]; // 交易所 2 的数据

          // 计算两个交易所的原始资金费率差值 (百分比)
          const rateDiffPercent = (ex1Data.rate - ex2Data.rate) * 100;

          // 核心判断：费率差的绝对值是否大于双边手续费？
          if (Math.abs(rateDiffPercent) > combinedFeePercent) {
            // 如果大于手续费，计算净利润率
            const netProfitPercent = Math.abs(rateDiffPercent) - combinedFeePercent;

            // 判断方向：哪个交易所费率高（做空），哪个费率低（做多）
            if (rateDiffPercent > 0) {
              // ex1 费率 > ex2 费率，应该做空 ex1，做多 ex2
              opportunities.push({
                longExchange: ex2Data.exchange,
                shortExchange: ex1Data.exchange,
                cleanedSymbol: cleanedSym,
                netProfitPercent: netProfitPercent,
              });
            } else {
              // ex2 费率 > ex1 费率，应该做空 ex2，做多 ex1
              opportunities.push({
                longExchange: ex1Data.exchange,
                shortExchange: ex2Data.exchange,
                cleanedSymbol: cleanedSym,
                netProfitPercent: netProfitPercent,
              });
            }
          }
        }
      }
    }

    // 步骤 3: 按净利润率降序排序
    opportunities.sort((a, b) => b.netProfitPercent - a.netProfitPercent);

    // 步骤 4: 格式化消息
    // 如果没有找到任何机会，返回空字符串
    if (!opportunities.length) {
      return '';
    }

    // 构建消息头，包含时间戳和阈值说明
    let message = `\n\n💰 **跨交易所套利机会 (${format(new Date(), 'HH:mm:ss')})**  ⚠️双边手续费 ${combinedFeePercent.toFixed(2)}%\n\n`;
    // 拼接每个套利机会的信息
    message += opportunities
      .map(
        ({ longExchange, shortExchange, cleanedSymbol, netProfitPercent }) =>
          // 格式：- 🟢多 [交易所] / 空🔴 [交易所] | [币种] | 净收益: [百分比]%
          `🟢多 ${longExchange} / 空🔴 ${shortExchange} | ${cleanedSymbol} | 😊净收益: ${netProfitPercent.toFixed(4)}%`
      )
      .join('\n\n'); // 使用换行符连接

    return message; // 返回最终的消息字符串
  }

  /**
   * @method clear
   * @description 清空当前存储的所有资金费率数据。
   * 在每次新的获取周期开始时调用，以确保数据是最新的。
   */
  clear(): void {
    // 重新初始化 fundingRates 对象，结构与构造函数中相同
    this.fundingRates = Object.keys(EXCHANGES).reduce((acc, name) => {
      acc[name] = {};
      return acc;
    }, {} as { [key: string]: { [key: string]: FundingRate } });
  }
}

/**
 * @function calculateRates
 * @description 根据原始资金费率和手续费率，计算衍生的费率指标。
 * @param fundingRate - 原始资金费率 (例如 0.0001)
 * @param feePercent - 单边交易手续费率 (%) (例如 0.06)
 * @returns 一个包含 apr, singleCycleNetRatePercent, dailyNetRatePercent 的对象。
 */
export function calculateRates(fundingRate: number, feePercent: number): { apr: number; singleCycleNetRatePercent: number; dailyNetRatePercent: number } {
  // 1. 计算原始 APR (主要用于初步筛选，假设一天结算 3 次)
  const rawApr = fundingRate * 3 * 365 * 100;

  // 2. 计算单次净收益率 (%)
  const fundingRatePercent = fundingRate * 100; // 将原始费率转为百分比
  // 单次净收益 = 原始费率(%) - 单边手续费(%)
  const singleCycleNetRatePercent = fundingRatePercent - feePercent;

  // 3. 计算单日净收益率 (%)
  // 假设一天结算 3 次
  const dailyFundingRatePercent = fundingRate * 3 * 100;
  let dailyNetRatePercent: number;
  // 注意：计算日净收益时，手续费只扣除一次（或加上一次），因为建仓和平仓通常在不同天或更长时间跨度。
  // 这里的计算逻辑可能需要根据实际策略调整，目前是按用户之前的要求处理。
  if (fundingRate >= 0) {
    // 正向费率：赚取费率，支付手续费
    dailyNetRatePercent = dailyFundingRatePercent - feePercent;
  } else {
    // 反向费率：支付费率，但反向操作时可以视为"赚取"了负费率，同时支付手续费
    // 如果是套保或对冲策略，可能仍需支付手续费。但若理解为"通过支付负费率获利"，则加上手续费？
    // 当前逻辑： 每日"收益"(负费率的绝对值) - 手续费。 (dailyFundingRatePercent 本身是负数)
    // 或者按照之前的理解：对于负费率，净收益是 负费率绝对值 - 手续费？ (-fundingRate*3*100 - feePercent)
    // **当前实现基于之前的注释 "反向: 每日费率 + 总手续费 (按用户要求)" -> dailyNetRatePercent = dailyFundingRatePercent + feePercent; **
    // 这表示，如果费率是 -0.03%，手续费 0.06%，日费率是 -0.09%，日净收益是 -0.09% + 0.06% = -0.03%？ 这似乎不太对。
    // **修正理解：** 对于收取负费率(做多支付)，日净收益应为 每日总费率(负) - 手续费。 对于支付负费率(做空收取)，日净收益应为 每日总费率(正) - 手续费。
    // 因此，统一计算：日净收益 = abs(每日总费率) - 手续费？ 也不完全对。
    // **保持现有计算方式，但添加注释说明其含义：**
    // 当前计算：将负费率视为成本，手续费是额外成本，所以总成本是 |每日费率| + 手续费。净收益是 -(|每日费率| + 手续费)?
    // 不对，之前的 `+ feePercent` 可能是指做空时，收到负费率，这个"收入"需要减去手续费。
    // 让我们重新审视： dailyFundingRatePercent 是负数。
    // 如果 dailyFundingRatePercent = -0.09%, feePercent = 0.06%
    // dailyNetRatePercent = -0.09% + 0.06% = -0.03%. 这意味着做多需要支付的总成本(费率+手续费)对应的收益率？
    // 还是应该理解为：日净收益 = - (需要支付的日费率绝对值 + 手续费)？ = -(0.09 + 0.06) = -0.15% ?
    // **暂时维持原代码逻辑 `dailyNetRatePercent = dailyFundingRatePercent + feePercent;` 并添加注释指出其可能需要根据具体策略复核。**
    // 假设策略是收取负费率(做空)：收取的费率 = -dailyFundingRatePercent。净收益 = (-dailyFundingRatePercent) - feePercent。
    // 假设策略是支付负费率(做多)：支付的费率 = dailyFundingRatePercent。净损失 = dailyFundingRatePercent - feePercent。
    // 当前实现似乎混合了概念。 **暂时维持现状，但强烈建议复核此处的计算逻辑。**
    dailyNetRatePercent = dailyFundingRatePercent + feePercent; // 存疑的计算方式，按用户先前要求保留
  }

  return { apr: rawApr, singleCycleNetRatePercent, dailyNetRatePercent };
}