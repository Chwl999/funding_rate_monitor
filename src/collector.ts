/**
 * @file collector.ts
 * @description 定义了 FundingRateCollector 类，用于收集、存储和处理来自不同交易所的资金费率数据，并提供生成套利机会消息的方法。
 */

import { format } from 'date-fns'; // 导入日期格式化函数
import { CONFIG, EXCHANGES, TRANSACTION_FEE_PERCENT, TIMESTAMPS_CACHE_FILE } from './config'; // 导入配置信息，包括交易所配置、阈值和手续费
import { logger } from './utils'; // 导入日志记录器
import * as fs from 'fs/promises'; // 用于异步文件系统操作
import { resolve } from 'path'; // 用于处理文件路径

/**
 * @interface FundingRate
 * @description 定义单个资金费率记录的结构。
 */
interface FundingRate {
  rate: number; // 原始资金费率 (例如 0.0001 代表 0.01%)
  apr: number; // 根据实际结算频率计算出的年化百分比 (%)
  singleCycleNetRatePercent: number; // 单次资金费率结算的净收益率 (%)，已扣除单边手续费
  dailyNetRatePercent: number; // 基于实际结算频率估算的日净收益率 (%)，已扣除单边手续费
  timestamp: Date; // 数据更新的时间戳
  nextFundingTimestamp: number | null; // 下一次资金费率结算的时间戳 (毫秒)
  frequencyPerDay: number; // 计算得出的每日结算次数
  intervalHours: number | null; // 计算得出的结算间隔小时数 (null 表示使用默认值)
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
  // 用于存储上一次获取的 nextFundingTimestamp (从缓存加载/更新到缓存)
  private previousTimestamps: { [exchange: string]: { [symbol: string]: number | null } } = {};
  // 从配置中读取的正向套利 APR 阈值 (%)
  private minPositiveApr: number;
  // 从配置中读取的反向套利 APR 阈值 (%)
  private minNegativeApr: number;
  // 从配置中读取的是否过滤负日净收益的开关
  private filterNegativeDailyNetRate: boolean;
  // 标记在一个获取周期内是否有时间戳被更新
  public timestampsChanged: boolean = false; // 添加标志位

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

    // 同步加载上一次的时间戳缓存 (构造函数中不适合直接用 await)
    this.loadTimestampsCacheSync();

    // 从全局 CONFIG 对象加载正负 APR 阈值
    this.minPositiveApr = CONFIG.thresholds.min_positive_apr;
    this.minNegativeApr = CONFIG.thresholds.min_negative_apr;
    // 从全局 CONFIG 对象加载过滤开关
    this.filterNegativeDailyNetRate = CONFIG.filter_negative_daily_net_rate;
  }

  /**
   * @method updateRate
   * @description 更新或添加指定交易所和交易对的资金费率。
   * 会自动调用 calculateRates 计算相关的衍生费率 (APR, 单次净收益率, 单日净收益率)。
   * @param exchange - 交易所名称 (例如 'binance')
   * @param symbol - 交易对名称 (例如 'BTCUSDT')
   * @param rate - 原始资金费率
   * @param nextFundingTimestamp - 下一次结算时间戳 (毫秒)，如果无法获取则为 null
   */
  updateRate(exchange: string, symbol: string, rate: number, nextFundingTimestamp: number | null): void {
    // Retrieve the previously stored timestamp for this pair
    // Ensure the exchange key exists before reading
    if (!this.previousTimestamps[exchange]) {
        this.previousTimestamps[exchange] = {};
    }
    const previousNextFundingTimestamp = this.previousTimestamps[exchange]?.[symbol] ?? null;

    // 调用 calculateRates 函数计算各种衍生费率及频率信息
    const { apr, singleCycleNetRatePercent, dailyNetRatePercent, frequencyPerDay, intervalHours } = calculateRates(
        rate,
        TRANSACTION_FEE_PERCENT,
        exchange,
        nextFundingTimestamp,
        previousNextFundingTimestamp
    );
    // 将计算结果和原始费率、时间戳存储到 fundingRates 对象中
    this.fundingRates[exchange][symbol] = {
      rate,
      apr, // 存储计算出的 APR
      singleCycleNetRatePercent, // 存储计算出的单次净收益率
      dailyNetRatePercent, // 存储计算出的单日净收益率
      timestamp: new Date(), // 记录当前时间为数据更新时间
      nextFundingTimestamp, // 存储下一次结算时间戳
      frequencyPerDay,    // 存储计算出的频率
      intervalHours,      // 存储计算出的间隔
    };
    // 更新内存中的时间戳
    const previousValue = this.previousTimestamps[exchange][symbol];
    if (previousValue !== nextFundingTimestamp) {
        // Ensure the exchange key exists before writing
        if (!this.previousTimestamps[exchange]) {
            this.previousTimestamps[exchange] = {};
        }
        this.previousTimestamps[exchange][symbol] = nextFundingTimestamp;
        this.timestampsChanged = true; // 只设置标志位，不立即保存
        // // 异步保存更新后的缓存，不阻塞主流程 (注释掉原来的保存调用)
        // this.saveTimestampsCache().catch(err => {
        //     logger.error(`异步保存时间戳缓存失败: ${err}`);
        // });
    }
    // 可选的日志记录 (当前被注释掉)
    // logger.info(
    //   `更新 ${exchange} 的资金费率: ${symbol} -> ${rate} (APR: ${apr.toFixed(2)}%, SingleNet: ${singleCycleNetRatePercent.toFixed(4)}%, DailyNet: ${dailyNetRatePercent.toFixed(4)}% 频次: ${frequencyPerDay} 间隔: ${intervalHours}h)`
    // );
  }

  /**
   * @method getArbitragePairs
   * @description 获取常规的单边高费率套利机会 (正向和反向)。
   * 根据配置的 APR 阈值筛选，并按 APR 排序，最后格式化成 Telegram 消息字符串。
   * 显示的是扣除手续费后的净收益率，并附带结算周期。
   * @returns 格式化后的 Telegram 消息字符串。
   */
  getArbitragePairs(): string {
    // 存储满足条件的正向套利机会: [交易所, 交易对, 原始APR, 单次净收益率, 单日净收益率, 结算间隔小时数, 每日频率]
    const positivePairs: [string, string, number, number, number, number | null, number][] = [];
    // 存储满足条件的反向套利机会: [交易所, 交易对, 原始APR, 单次净收益率, 单日净收益率, 结算间隔小时数, 每日频率]
    const negativePairs: [string, string, number, number, number, number | null, number][] = [];

    // 遍历所有交易所的费率数据
    for (const exchangeName in this.fundingRates) {
      for (const [symbol, rateData] of Object.entries(this.fundingRates[exchangeName])) {
        // 如果启用了过滤，并且日净收益率为负，则跳过
        if (this.filterNegativeDailyNetRate && rateData.dailyNetRatePercent < 0) {
          continue;
        }

        // 筛选基于原始 APR (rateData.apr) 是否达到阈值
        if (rateData.apr >= this.minPositiveApr) {
          positivePairs.push([exchangeName, symbol, rateData.apr, rateData.singleCycleNetRatePercent, rateData.dailyNetRatePercent, rateData.intervalHours, rateData.frequencyPerDay]);
        } else if (rateData.apr <= this.minNegativeApr) {
          negativePairs.push([exchangeName, symbol, rateData.apr, rateData.singleCycleNetRatePercent, rateData.dailyNetRatePercent, rateData.intervalHours, rateData.frequencyPerDay]);
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
        .map(([ex, sym, _apr, singleCycleNetRate, dailyNetRate, intervalHours, frequencyPerDay]) => {
          // 格式化结算周期信息
          const intervalStr = intervalHours !== null
              ? `(${intervalHours}h)`
              : `(${frequencyPerDay}次/天)`; // 如果是默认值，显示次数
          // 格式化每一条机会：交易所 | 清理后的币种 | 单次净收益 | 单日净收益 (结算周期)
          return `${ex} | ${cleanSymbol(sym)} | 单次: ${singleCycleNetRate.toFixed(4)}% | 单日: ${dailyNetRate.toFixed(4)}% ${intervalStr}`;
        })
        .join('\n'); // 使用换行符连接
    } else {
      message += '  暂无显著正向套利机会\n'; // 如果没有机会，显示提示信息
    }

    // 添加反向套利机会部分
    message += `\n\n📉 **反向套利机会，借币卖出现货，做多合约 (年化 ≤ ${this.minNegativeApr}%)**\n`; // 标题和阈值说明
    if (negativePairs.length) {
      message += negativePairs
        .map(([ex, sym, _apr, singleCycleNetRate, dailyNetRate, intervalHours, frequencyPerDay]) => {
          // 格式化结算周期信息
          const intervalStr = intervalHours !== null
              ? `(${intervalHours}h)`
              : `(${frequencyPerDay}次/天)`; // 如果是默认值，显示次数
          // 格式化每一条机会
          return `${ex} | ${cleanSymbol(sym)} | 单次: ${singleCycleNetRate.toFixed(4)}% | 单日: ${dailyNetRate.toFixed(4)}% ${intervalStr}`; 
        })
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

  /**
   * @method loadTimestampsCacheSync
   * @description 同步加载时间戳缓存文件。仅用于构造函数。
   * @private
   */
  private loadTimestampsCacheSync(): void {
    const cachePath = resolve(__dirname, '../', TIMESTAMPS_CACHE_FILE);
    try {
      logger.info(`尝试加载时间戳缓存: ${cachePath}`);
      // 注意：在 Node.js 14+ 中，fs/promises 仍然存在，但同步读取需要用 fs
      const data = require('fs').readFileSync(cachePath, 'utf-8');
      this.previousTimestamps = JSON.parse(data);
      logger.info('时间戳缓存加载成功');
    } catch (error: any) {
      if (error.code === 'ENOENT') {
        logger.info('未找到时间戳缓存文件，将创建新的缓存。');
        this.previousTimestamps = {};
      } else {
        logger.error(`加载时间戳缓存文件失败: ${error}. 将使用空缓存。`);
        this.previousTimestamps = {};
      }
    }
  }

  /**
   * @method saveTimestampsCache
   * @description 异步保存当前的时间戳到缓存文件。
   * @private
   */
  public async saveTimestampsCache(): Promise<void> {
    const cachePath = resolve(__dirname, '../', TIMESTAMPS_CACHE_FILE);
    try {
      // 使用 null, 2 参数进行格式化，提高可读性
      const data = JSON.stringify(this.previousTimestamps, null, 2);
      await fs.writeFile(cachePath, data);
      logger.info(`时间戳缓存已成功保存到: ${cachePath}`); // 确认保存成功
    } catch (error) {
      // 记录更详细的错误日志，但不向上抛出，避免主循环中断
      logger.error(`异步保存时间戳缓存文件 (${cachePath}) 失败: ${error instanceof Error ? error.message : error}`);
    }
  }
}

/**
 * @function calculateRates
 * @description 根据原始资金费率和手续费率，计算衍生的费率指标。
 * @param fundingRate - 原始资金费率 (例如 0.0001)
 * @param feePercent - 单边交易手续费率 (%) (例如 0.06)
 * @param exchange - 交易所名称 (用于确定结算频率或作为备用)
 * @param currentNextFundingTimestamp - 当前获取到的下一次结算时间戳 (毫秒，可选)
 * @param previousNextFundingTimestamp - 上一次获取到的下一次结算时间戳 (毫秒，可选)
 * @returns 一个包含 apr, singleCycleNetRatePercent, dailyNetRatePercent, frequencyPerDay, intervalHours 的对象。
 */
export function calculateRates(
    fundingRate: number,
    feePercent: number,
    exchange: string,
    currentNextFundingTimestamp: number | null,
    previousNextFundingTimestamp: number | null
): { apr: number; singleCycleNetRatePercent: number; dailyNetRatePercent: number; frequencyPerDay: number; intervalHours: number | null } {

  // 1. 确定每日资金费率结算频率
  let frequencyPerDay: number | null = null;
  const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;
  const MIN_INTERVAL_MS = 1 * 60 * 60 * 1000; // 1 hour minimum interval
  const MAX_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours maximum interval

  let intervalHours: number | null = null; // 初始化间隔小时数

  // 尝试根据时间戳动态计算频率
  if (currentNextFundingTimestamp && previousNextFundingTimestamp && currentNextFundingTimestamp > previousNextFundingTimestamp) {
    const intervalMs = currentNextFundingTimestamp - previousNextFundingTimestamp;
    // 检查间隔是否在合理范围内 (例如，1 小时到 24 小时之间)
    if (intervalMs >= MIN_INTERVAL_MS && intervalMs <= MAX_INTERVAL_MS) {
      // 计算每天的次数，四舍五入到最近的整数，并确保至少为 1
      frequencyPerDay = Math.max(1, Math.round(MILLISECONDS_PER_DAY / intervalMs));
      intervalHours = parseFloat((intervalMs / (60 * 60 * 1000)).toFixed(1)); // 计算间隔小时数，保留一位小数
      // logger.debug(`动态计算 ${exchange} ${fundingRate} 频率: ${frequencyPerDay}次/天 (间隔: ${intervalMs / (60 * 60 * 1000)} 小时)`);
    } else {
       logger.warn(`计算 ${exchange} 频率时时间戳间隔异常: ${intervalMs} ms. 当前: ${currentNextFundingTimestamp}, 上次: ${previousNextFundingTimestamp}. 将使用默认频率.`);
    }
  }

  // 如果动态计算失败或未提供足够的时间戳，则使用默认频率
  if (frequencyPerDay === null) {
    switch (exchange) {
      case 'binance':
      case 'okx':
      case 'bybit':
      case 'bitget': // 假设 Bitget 也是 8 小时结算
      case 'gate':   // Gate.io 确认是 8 小时
        frequencyPerDay = 3;
        break;
      default:
        logger.warn(`使用 ${exchange} 默认频率: ${frequencyPerDay}次/天`);
    }
  }

  // 2. 计算 APR (基于计算出的频率)
  const apr = fundingRate * frequencyPerDay! * 365 * 100;

  // 3. 计算单次净收益率 (%) - 这部分不受频率影响
  const fundingRatePercent = fundingRate * 100; // 将原始费率转为百分比
  let singleCycleNetRatePercent: number;

  // 4. 计算单日净收益率 (%) - 基于计算出的频率
  const dailyFundingRatePercent = fundingRate * frequencyPerDay! * 100;
  let dailyNetRatePercent: number;
  // 注意：计算日净收益时，手续费只扣除一次（或加上一次），因为建仓和平仓通常在不同天或更长时间跨度。

  if (fundingRate >= 0) {
    // 正向套利：赚取费率，支付手续费
    singleCycleNetRatePercent = fundingRatePercent - feePercent;
    dailyNetRatePercent = dailyFundingRatePercent - feePercent;
  } else {
    // 反向套利：收取负费率（等同于盈利），支付手续费
    // 净收益 = 收取的费率绝对值 - 单边手续费
    singleCycleNetRatePercent = Math.abs(fundingRatePercent) - feePercent;
    dailyNetRatePercent = Math.abs(dailyFundingRatePercent) - feePercent;
  }

  return { apr, singleCycleNetRatePercent, dailyNetRatePercent, frequencyPerDay: frequencyPerDay!, intervalHours };
}