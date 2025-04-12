/**
 * @file utils.ts
 * @description 提供各种工具函数，包括数据获取、消息发送、日志记录、缓存管理等。
 */

import axios, { AxiosError } from 'axios'; // 用于发送 HTTP 请求
import WebSocket from 'ws'; // 用于 WebSocket 连接
import * as fs from 'fs/promises'; // 用于异步文件系统操作 (读写缓存)
import { resolve } from 'path'; // 用于处理文件路径
import * as pino from 'pino'; // 高性能的 JSON 日志库
import { EXCHANGES, TELEGRAM_CONFIG, CACHE_FILE, CACHE_DURATION, TOP_PAIRS_COUNT } from './config'; // 导入配置项
import { FundingRateCollector } from './collector'; // 导入资金费率收集器类

// ----------- 日志配置 ----------- //
/**
 * @const logger
 * @description Pino 日志记录器实例。
 * 配置为输出到滚动日志文件 `./funding_rate_monitor.log`。
 * - level: 'info' - 记录 info 及以上级别的日志。
 * - target: 'pino-roll' - 使用 pino-roll 进行日志滚动。
 * - file: 日志文件路径。
 * - size: '5m' - 每个日志文件最大 5MB。
 * - limit: { count: 5 } - 最多保留 5 个历史日志文件。
 * - mkdir: true - 如果日志目录不存在，则自动创建。
 */
export const logger = pino.default({
  level: 'info',
  transport: {
    target: 'pino-roll',
    options: {
      file: './funding_rate_monitor.log',
      size: '5m',
      limit: { count: 5 },
      mkdir: true
    },
  },
});

// ----------- 交易对缓存 ----------- //
/**
 * @interface CacheData
 * @description 定义交易对缓存文件的结构。
 */
interface CacheData {
  timestamp: number; // 缓存生成时的时间戳 (秒)
  pairs: string[]; // 缓存的交易对列表
}

/**
 * @function fetchTopLiquidityPairs
 * @description 获取币安交易所流动性最高的 TOP_PAIRS_COUNT 个 USDT 永续合约交易对。
 * 使用文件缓存机制，避免频繁请求 API。
 * @returns 返回一个包含交易对名称字符串的数组。
 */
export async function fetchTopLiquidityPairs(): Promise<string[]> {
  // 解析缓存文件的绝对路径
  const cachePath = resolve(__dirname, '../', CACHE_FILE);
  // 初始化缓存对象
  let cache: CacheData = { timestamp: 0, pairs: [] };

  // 尝试读取缓存文件
  try {
    const cacheContent = await fs.readFile(cachePath, 'utf-8');
    cache = JSON.parse(cacheContent);
    // 检查缓存是否在有效期内 (CACHE_DURATION 秒)
    if (Date.now() / 1000 - cache.timestamp < CACHE_DURATION) {
      logger.info(`使用缓存的交易对列表 (${cache.pairs.length} 个)`);
      return cache.pairs; // 缓存有效，直接返回缓存数据
    }
    logger.info('交易对缓存已过期');
  } catch (error: any) {
    // 如果读取失败
    if (error.code !== 'ENOENT') {
      // 如果不是"文件未找到"错误，则记录警告
      logger.warn(`读取缓存文件失败: ${error}`);
    } else {
      // 如果是"文件未找到"错误 (首次运行)，则尝试创建空的缓存文件
      logger.info('未找到缓存文件，将创建新的缓存');
      try {
        await fs.writeFile(cachePath, JSON.stringify(cache)); // 写入初始空缓存
      } catch (writeError) {
        logger.error(`创建初始缓存文件失败: ${writeError}`);
      }
    }
  }

  // 如果缓存无效或不存在，则从币安 API 获取
  logger.info('正在从 Binance API 获取最新交易对列表...');
  try {
    // 获取币安的配置信息
    const config = EXCHANGES.binance;
    // 请求币安的 Ticker 接口 (获取所有交易对信息)
    const response = await axios.get(config.rest_url_ticker!, { timeout: 5000 }); // 设置 5 秒超时
    // 处理 API 响应数据
    const pairs = response.data
      // 1. 筛选出以 USDT 结尾的永续合约 (根据 config.filter_suffix)
      .filter((item: any) => item[config.symbol_key].endsWith(config.filter_suffix))
      // 2. 提取交易对名称和 24 小时交易量 (根据 config.symbol_key 和 config.volume_key)
      .map((item: any) => [item[config.symbol_key], parseFloat(item[config.volume_key!])])
      // 3. 按交易量降序排序
      .sort((a: [string, number], b: [string, number]) => b[1] - a[1])
      // 4. 截取交易量最高的 TOP_PAIRS_COUNT 个
      .slice(0, TOP_PAIRS_COUNT)
      // 5. 只保留交易对名称
      .map((p: [string, number]) => p[0]);

    // 更新缓存对象
    cache = { timestamp: Date.now() / 1000, pairs };
    // 将新的交易对列表写入缓存文件
    try {
      await fs.writeFile(cachePath, JSON.stringify(cache));
      logger.info(`已更新交易对缓存文件: ${cachePath} (${pairs.length} 个)`);
    } catch (writeError) {
      logger.error(`写入交易对缓存文件失败: ${writeError}`);
    }
    return pairs; // 返回获取到的交易对列表

  } catch (error) {
    // 如果 API 请求失败
    logger.error(`通过 API 获取币安交易对失败: ${error}`);
    // 优先返回缓存中的数据 (即使已过期)，如果没有缓存则返回空数组
    logger.warn('API 请求失败，将尝试使用旧缓存或返回空列表');
    return cache.pairs.length ? cache.pairs : [];
  }
}

/**
 * @function fetchFundingRates
 * @description 获取指定交易对列表在所有已配置交易所的资金费率。
 * 优先尝试通过 REST API 获取，如果失败或不支持，则回退到 WebSocket 获取。
 * @param collector - FundingRateCollector 实例，用于存储获取到的费率。
 * @param pairs - 需要获取费率的交易对列表 (通常来自 fetchTopLiquidityPairs)。
 */
export async function fetchFundingRates(collector: FundingRateCollector, pairs: string[]): Promise<void> {
  // 遍历配置文件中定义的所有交易所
  for (const [exchangeName, config] of Object.entries(EXCHANGES)) {
    try {
      // 1. 交易对名称适配：根据不同交易所的要求调整交易对格式
      let adjustedPairs = pairs;
      if (exchangeName === 'okx') {
        // OKX 需要 'BTC-USDT-SWAP' 格式
        adjustedPairs = pairs.map((p) => p.replace('USDT', '-USDT-SWAP'));
      } else if (exchangeName === 'gate') {
        // Gate.io 需要 'BTC_USDT' 格式
        adjustedPairs = pairs.map((p) => p.replace('USDT', '_USDT'));
      }
      // 其他交易所 (Binance, Bybit, Bitget) 使用原始格式 (例如 'BTCUSDT')

      // 2. 尝试通过 REST API 获取费率
      let ratesFetched = false; // 标记是否成功通过 REST 获取到数据
      try {
        logger.info(`尝试通过 REST API 获取 ${exchangeName} 的资金费率...`);
        // 针对 OKX 的特殊处理：需要为每个交易对单独发请求
        if (exchangeName === 'okx') {
          for (const pair of adjustedPairs) {
            try {
              const response = await axios.get(`${config.rest_url_funding}?instId=${pair}`, { timeout: 5000 });
              const item = response.data?.data?.[0]; // 安全访问嵌套属性
              if (item && item.fundingRate != null) {
                // 使用 collector 更新费率，注意传回原始的交易对名称 (pair)
                collector.updateRate(exchangeName, item.instId, parseFloat(item.fundingRate));
                ratesFetched = true;
              }
            } catch (pairError) {
               logger.warn(`获取 ${exchangeName} ${pair} 费率失败 (REST): ${pairError}`);
            }
          }
        } else {
          // 对于其他交易所，通常一个请求可以获取多个或所有交易对的费率
          const response = await axios.get(config.rest_url_funding, { timeout: 5000 });
          const data = response.data;

          // --- 根据不同交易所的 API 响应结构解析数据 --- //
          if (exchangeName === 'binance') {
            if (Array.isArray(data)) {
              for (const item of data) {
                // 检查交易对是否在我们关心的列表中，并且费率存在
                if (adjustedPairs.includes(item.symbol) && item.lastFundingRate != null) {
                  collector.updateRate(exchangeName, item.symbol, parseFloat(item.lastFundingRate));
                  ratesFetched = true;
                }
              }
            } else {
               logger.warn(`${exchangeName} REST 响应格式非预期数组: ${JSON.stringify(data)}`);
            }
          } else if (exchangeName === 'bybit') {
            if (data?.result?.list && Array.isArray(data.result.list)) {
              for (const item of data.result.list) {
                if (adjustedPairs.includes(item.symbol) && item.fundingRate != null) {
                  collector.updateRate(exchangeName, item.symbol, parseFloat(item.fundingRate));
                  ratesFetched = true;
                }
              }
            } else {
              logger.warn(`${exchangeName} REST 响应格式非预期: ${JSON.stringify(data)}`);
            }
          } else if (exchangeName === 'bitget') {
             if (data?.data && Array.isArray(data.data)) {
                for (const item of data.data) {
                  if (adjustedPairs.includes(item.symbol) && item.fundingRate != null) {
                    collector.updateRate(exchangeName, item.symbol, parseFloat(item.fundingRate));
                    ratesFetched = true;
                  }
                }
            } else {
              logger.warn(`${exchangeName} REST 响应格式非预期: ${JSON.stringify(data)}`);
            }
          } else if (exchangeName === 'gate') {
            if (Array.isArray(data)) {
              for (const item of data) {
                if (adjustedPairs.includes(item.contract) && item.funding_rate != null) {
                  collector.updateRate(exchangeName, item.contract, parseFloat(item.funding_rate));
                  ratesFetched = true;
                }
              }
            } else {
              logger.warn(`${exchangeName} REST 响应格式非预期数组: ${JSON.stringify(data)}`);
            }
          }
          // --- 解析结束 --- //
        }

        // 如果通过 REST 成功获取到任何费率数据，则记录日志并跳过该交易所的 WebSocket 获取
        if (ratesFetched) {
          logger.info(`${exchangeName} 通过 REST 成功获取到部分或全部资金费率`);
          continue; // 处理下一个交易所
        } else {
          logger.warn(`${exchangeName} 未能通过 REST 获取到任何有效资金费率`);
        }

      } catch (error) {
        // 如果 REST 请求过程中发生错误
        logger.warn(`${exchangeName} REST API 请求失败，将尝试 WebSocket: ${error instanceof Error ? error.message : error}`);
      }

      // 3. 如果 REST 失败或未获取到数据，则尝试通过 WebSocket 获取
      logger.info(`尝试通过 WebSocket 获取 ${exchangeName} 的资金费率...`);
      // 检查是否有配置 WebSocket URL
      if (config.ws_url) {
        await fetchFundingRatesViaWebSocket(exchangeName, config.ws_url, adjustedPairs, collector);
      } else {
        logger.warn(`${exchangeName} 未配置 WebSocket URL，无法通过 WebSocket 获取费率`);
      }

    } catch (error) {
      // 捕获处理单个交易所时的顶层错误
      logger.error(`${exchangeName} 获取资金费率过程中发生错误: ${error instanceof Error ? error.message : error}`);
    }
  }
}

/**
 * @function fetchFundingRatesViaWebSocket
 * @description 通过 WebSocket 连接获取指定交易所的资金费率。
 * 会建立连接、发送订阅消息、解析收到的消息，并在超时或获取到数据后关闭连接。
 * @param exchangeName - 交易所名称
 * @param wsUrl - WebSocket 连接地址
 * @param pairs - 需要订阅的、已适配该交易所格式的交易对列表
 * @param collector - FundingRateCollector 实例，用于存储费率
 * @returns 一个 Promise，在 WebSocket 连接关闭时 resolve。
 */
async function fetchFundingRatesViaWebSocket(
  exchangeName: string,
  wsUrl: string,
  pairs: string[],
  collector: FundingRateCollector
): Promise<void> {
  return new Promise((resolve) => {
    const ws = new WebSocket(wsUrl); // 创建 WebSocket 实例
    let dataReceived = false; // 标记是否接收到任何有效费率数据

    // 设置超时定时器，防止 WebSocket 长时间无响应或无法获取数据
    const timeoutDuration = exchangeName === 'gate' ? 15000 : 10000; // Gate.io 的 WS 响应较慢，延长超时时间
    const timeout = setTimeout(() => {
      logger.warn(`${exchangeName} WebSocket 连接超时 (${timeoutDuration}ms)，即将关闭`);
      ws.close(); // 关闭 WebSocket 连接
      resolve(); // resolve Promise，让主流程继续
    }, timeoutDuration);

    // --- WebSocket 事件监听 --- //

    // 连接建立成功时
    ws.on('open', () => {
      logger.info(`${exchangeName} WebSocket 连接已建立`);
      // 生成需要发送的订阅消息 (可能有多条，因为会分批发送)
      const subscribeMsgs = generateSubscribeMsg(exchangeName, pairs);
      // 遍历并发送所有订阅消息
      for (const msg of subscribeMsgs) {
        try {
          const msgString = JSON.stringify(msg);
          ws.send(msgString);
          logger.info(`${exchangeName} 发送 WebSocket 订阅消息: ${msgString}`);
        } catch (error) {
          logger.error(`${exchangeName} 发送 WebSocket 订阅消息失败: ${error}`);
        }
      }
    });

    // 收到消息时
    ws.on('message', (data: Buffer) => {
      try {
        const parsed = JSON.parse(data.toString()); // 解析收到的 JSON 数据
        // 调用 parseFundingRate 解析出资金费率信息 ([symbol, rate] 数组)
        const rates = parseFundingRate(exchangeName, parsed);
        // 遍历解析出的费率
        for (const [symbol, rate] of rates) {
          // 检查数据是否有效，且是我们订阅的交易对
          if (symbol && rate != null && pairs.includes(symbol)) {
            // 使用 collector 更新费率
            collector.updateRate(exchangeName, symbol, rate);
            dataReceived = true; // 标记已收到有效数据
            // logger.debug(`${exchangeName} 收到资金费率 (WebSocket): ${symbol} -> ${rate}`); // 使用 debug 级别避免过多日志
          }
        }
      } catch (error) {
        logger.error(`解析 ${exchangeName} WebSocket 消息失败: ${error}, 原始数据: ${data.toString()}`);
      }
    });

    // 发生错误时
    ws.on('error', (error) => {
      logger.error(`${exchangeName} WebSocket 发生错误: ${error}`);
      // 错误发生时，通常连接也会关闭，所以不需要在这里手动 close 或 resolve
    });

    // 连接关闭时
    ws.on('close', (code, reason) => {
      clearTimeout(timeout); // 清除超时定时器
      const reasonString = reason ? reason.toString() : '无明确原因';
      logger.info(`${exchangeName} WebSocket 连接已关闭 (Code: ${code}, Reason: ${reasonString})。${dataReceived ? '期间已获取到数据' : '期间未获取到有效数据'}`);
      resolve(); // resolve Promise，表示此交易所的 WebSocket 流程结束
    });
  });
}

/**
 * @function generateSubscribeMsg
 * @description 根据交易所名称和交易对列表，生成用于 WebSocket 订阅的特定格式的消息。
 * 不同交易所的订阅消息格式不同。
 * @param exchangeName - 交易所名称
 * @param symbols - 需要订阅的交易对列表 (已适配该交易所格式)
 * @returns 返回一个包含一个或多个订阅消息对象的数组 (因为可能需要分批订阅)。
 */
function generateSubscribeMsg(exchangeName: string, symbols: string[]): any[] {
  const batchSize = 10; // 定义单次订阅允许的最大交易对数量 (一个保守值，部分交易所可能允许更多)
  const batches: string[][] = []; // 用于存储分批后的交易对列表
  // 将 symbols 按 batchSize 分批
  for (let i = 0; i < symbols.length; i += batchSize) {
    batches.push(symbols.slice(i, i + batchSize));
  }

  // 定义各交易所的订阅消息生成函数
  const configs: { [key: string]: (batch: string[]) => any } = {
    binance: (batch) => ({
      method: 'SUBSCRIBE',
      // Binance 格式: <symbol>@markPrice
      params: batch.map((s) => `${s.toLowerCase()}@markPrice`), // 注意转小写
      id: 1, // 可以是任意 ID
    }),
    okx: (batch) => ({
      op: 'subscribe',
      // OKX 格式: { channel: 'funding-rate', instId: <symbol> }
      args: batch.map((s) => ({ channel: 'funding-rate', instId: s })),
    }),
    bybit: (batch) => ({
      op: 'subscribe',
      // Bybit V5 (Unified Account) Ticker 频道似乎不直接提供 funding rate? 需要确认。
      // 如果是旧版 API 或特定频道，格式可能是 `instrument_info.100ms.<symbol>` 或 `publicTrade.<symbol>` 等
      // **假设当前配置的 ws_url 对应的是 Ticker 频道，尝试订阅 Ticker**
      // 注意：Bybit Ticker 可能不包含资金费率，或者需要特定订阅。
      // 查阅 Bybit V5 文档，资金费率在 Tickers (Linear/Inverse) 中提供: `tickers.<symbol>`
      args: batch.map((s) => `tickers.${s}`),
    }),
    bitget: (batch) => ({
      op: 'subscribe',
      // Bitget 格式: { instType: 'USDT-FUTURES', channel: 'ticker', instId: <symbol> }
      args: batch.map((s) => ({ instType: 'USDT-FUTURES', channel: 'ticker', instId: s })),
    }),
    gate: (batch) => ({
      time: Math.floor(Date.now() / 1000),
      channel: 'futures.tickers', // Gate 使用 'futures.tickers' 频道获取包含资金费率的信息
      event: 'subscribe',
      payload: batch, // 直接将交易对数组作为 payload
      // id: 1, // Gate 的订阅似乎不需要 id
    }),
  };

  // 对每个批次调用对应交易所的生成函数
  return batches.map((batch) => {
    const generator = configs[exchangeName];
    if (generator) {
      return generator(batch);
    } else {
      logger.warn(`未找到 ${exchangeName} 的 WebSocket 订阅消息生成配置`);
      return {}; // 返回空对象避免发送无效消息
    }
  }).filter(msg => Object.keys(msg).length > 0); // 过滤掉空对象
}

/**
 * @function parseFundingRate
 * @description 解析来自不同交易所 WebSocket 的原始消息数据，提取资金费率。
 * @param exchangeName - 交易所名称
 * @param data - 从 WebSocket 收到的已解析的 JSON 对象
 * @returns 返回一个包含 [symbol, rate] 对的数组。如果消息无效或不包含费率，则返回空数组或包含 null 值的数组。
 */
function parseFundingRate(exchangeName: string, data: any): [string | null, number | null][] {
  try {
    // 定义各交易所的消息解析逻辑
    const parsers: { [key: string]: (d: any) => [string | null, number | null][] } = {
      binance: (d) => {
        // Binance markPrice 流: { "e": "markPriceUpdate", "s": "BTCUSDT", "r": "0.00010000", ... }
        if (d.e === 'markPriceUpdate' && d.s && d.r != null) {
          return [[d.s, parseFloat(d.r)]];
        } else {
          // Binance 可能还推送心跳或其他类型消息，忽略它们
          return [];
        }
      },
      okx: (d) => {
        // OKX funding-rate 流: { "arg": { "channel": "funding-rate", "instId": "BTC-USDT-SWAP" }, "data": [{ "fundingRate": "0.0001", ... }] }
        if (d.arg?.channel === 'funding-rate' && d.data?.[0]?.fundingRate != null) {
          return [[d.arg.instId, parseFloat(d.data[0].fundingRate)]];
        } else {
          // OKX 可能推送订阅成功确认或其他消息
          return [];
        }
      },
      bybit: (d) => {
        // Bybit V5 tickers 流: { "topic": "tickers.BTCUSDT", "type": "snapshot" / "delta", "data": { "symbol": "BTCUSDT", "fundingRate": "0.0001", ... } }
        // 检查是否是 tickers 数据，并包含 symbol 和 fundingRate
        if (d.topic?.startsWith('tickers.') && d.data?.symbol && d.data?.fundingRate != null) {
            return [[d.data.symbol, parseFloat(d.data.fundingRate)]];
        } else {
          // Bybit 可能推送心跳或其他消息
            return [];
        }
      },
      bitget: (d) => {
        // Bitget ticker 流: { "action": "snapshot" / "update", "arg": { "instType": "USDT-FUTURES", "channel": "ticker", "instId": "BTCUSDT" }, "data": [{ "fundingRate": "0.0001", ... }] }
        if (d.arg?.channel === 'ticker' && d.data?.[0]?.fundingRate != null) {
          return [[d.arg.instId, parseFloat(d.data[0].fundingRate)]];
        } else {
          // Bitget 可能推送订阅确认或其他消息
          return [];
        }
      },
      gate: (d) => {
        // Gate futures.tickers 流: { "time": ..., "channel": "futures.tickers", "event": "update", "result": [{ "contract": "BTC_USDT", "funding_rate": "0.0001", ... }] }
        if (d.channel === 'futures.tickers' && d.event === 'update' && Array.isArray(d.result)) {
          // 可能在一个消息中包含多个交易对的更新
          return d.result
            .filter((item: any) => item.contract && item.funding_rate != null)
            .map((item: any) => [item.contract, parseFloat(item.funding_rate)]);
        } else {
          // Gate 可能推送订阅确认或其他消息
          return [];
        }
      },
    };

    // 调用对应交易所的解析函数
    const parser = parsers[exchangeName];
    if (parser) {
      return parser(data);
    } else {
      logger.warn(`未找到 ${exchangeName} 的 WebSocket 消息解析器`);
      return []; // 没有解析器，返回空数组
    }
  } catch (error) {
    // 解析过程中发生任何错误
    logger.error(`解析 ${exchangeName} WebSocket 数据时发生内部错误: ${error}`);
    return []; // 返回空数组表示解析失败
  }
}

// ----------- Telegram 消息发送 ----------- //

/**
 * @function sendTelegramMessage
 * @description 使用配置的 Telegram Bot Token 和 Chat ID 发送消息。
 * 会处理 MarkdownV2 格式的转义，并增加重试机制。
 * @param message - 要发送的消息文本 (支持 MarkdownV2 语法)。
 * @param retries - 内部重试次数，外部调用时不需要传。
 */
export async function sendTelegramMessage(message: string, retries = 3): Promise<void> {
  // 检查 Telegram 配置是否存在
  if (!TELEGRAM_CONFIG.bot_token || !TELEGRAM_CONFIG.chat_id) {
    logger.error('Telegram bot_token 或 chat_id 未配置，无法发送消息');
    return; // 提前退出
  }

  // Telegram Bot API 的 URL
  const url = `https://api.telegram.org/bot${TELEGRAM_CONFIG.bot_token}/sendMessage`;
  // 对 MarkdownV2 的特殊字符进行转义
  const escapedMessage = message.replace(/([_*[\]()~`>#+-=|{}.!])/g, '\\$1');

  try {
    // 发送 POST 请求到 Telegram API
    await axios.post(url, {
      chat_id: TELEGRAM_CONFIG.chat_id,
      text: escapedMessage,
      parse_mode: 'MarkdownV2', // 指定使用 MarkdownV2 解析
      disable_web_page_preview: true, // 禁用链接预览
    }, { timeout: 10000 }); // 设置 10 秒超时
    // logger.info('Telegram 消息发送成功'); // 避免过多日志，可在需要时取消注释

  } catch (error) {
    const axiosError = error as AxiosError; // 类型断言
    logger.error(`发送 Telegram 消息失败: ${axiosError.response?.status} ${axiosError.response?.data}`);

    // 处理 Telegram API 的速率限制 (429 Too Many Requests)
    if (axiosError.response?.status === 429 && retries > 0) {
      // 从响应头或响应体中获取建议的重试延迟时间 (秒)
      const retryAfter = (axiosError.response?.headers?.[ 'retry-after'] || (axiosError.response?.data as any)?.parameters?.retry_after || 5) as number;
      logger.warn(`触发 Telegram 速率限制，将在 ${retryAfter} 秒后重试 (${retries} 次剩余)...`);
      // 等待指定时间
      await new Promise(resolve => setTimeout(resolve, retryAfter * 1000));
      // 递归调用自身进行重试，并将重试次数减 1
      await sendTelegramMessage(message, retries - 1);
    } else if (retries > 0) {
      // 对于其他错误，也进行重试 (例如网络波动)
      logger.warn(`发送 Telegram 消息遇到其他错误，将在 5 秒后重试 (${retries} 次剩余)...`);
      await new Promise(resolve => setTimeout(resolve, 5000));
      await sendTelegramMessage(message, retries - 1);
    } else {
      // 重试次数耗尽后仍然失败
      logger.error('Telegram 消息发送重试次数已耗尽');
    }
  }
}

