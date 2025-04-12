import axios, { AxiosError } from 'axios';
import WebSocket from 'ws';
import * as fs from 'fs/promises';
import { resolve } from 'path';
import * as pino from 'pino';
import { EXCHANGES, TELEGRAM_CONFIG, CACHE_FILE, CACHE_DURATION, TOP_PAIRS_COUNT } from './config';
import { FundingRateCollector } from './collector';
// 配置日志
export const logger = pino.default({
  level: 'info',
  transport: {
    target: 'pino-roll',
    options: {
      file: './funding_rate_monitor.log',
      size: '5m',    // 每个日志文件最大 10MB
      limit: { count: 5 }, // 保留 5 个历史文件
      mkdir: true     // 自动创建日志目录
    },
  },
});

// 缓存交易对
interface CacheData {
  timestamp: number;
  pairs: string[];
}

export async function fetchTopLiquidityPairs(): Promise<string[]> {
  const cachePath = resolve(__dirname, '../', CACHE_FILE);
  let cache: CacheData = { timestamp: 0, pairs: [] };

  try {
    const cacheContent = await fs.readFile(cachePath, 'utf-8');
    cache = JSON.parse(cacheContent);
    if (Date.now() / 1000 - cache.timestamp < CACHE_DURATION) {
      return cache.pairs;
    }
  } catch (error: any) {
    if (error.code !== 'ENOENT') {
      logger.warn(`读取缓存失败: ${error}`);
    } else {
      // 初始化空缓存
      await fs.writeFile(cachePath, JSON.stringify(cache));
    }
  }

  try {
    const config = EXCHANGES.binance;
    const response = await axios.get(config.rest_url_ticker!, { timeout: 5000 });
    const pairs = response.data
      .filter((item: any) => item[config.symbol_key].endsWith(config.filter_suffix))
      .map((item: any) => [item[config.symbol_key], parseFloat(item[config.volume_key!])])
      .sort((a: [string, number], b: [string, number]) => b[1] - a[1])
      .slice(0, TOP_PAIRS_COUNT)
      .map((p: [string, number]) => p[0]);

    cache = { timestamp: Date.now() / 1000, pairs };
    await fs.writeFile(cachePath, JSON.stringify(cache));
    return pairs;
  } catch (error) {
    logger.error(`获取币安交易对失败: ${error}`);
    return cache.pairs.length ? cache.pairs : [];
  }
}

export async function fetchFundingRates(collector: FundingRateCollector, pairs: string[]): Promise<void> {
  for (const [exchangeName, config] of Object.entries(EXCHANGES)) {
    try {
      // 交易对名称转换
      let adjustedPairs = pairs;
      if (exchangeName === 'okx') {
        adjustedPairs = pairs.map((p) => p.replace('USDT', '-USDT-SWAP'));
      } else if (exchangeName === 'gate') {
        adjustedPairs = pairs.map((p) => p.replace('USDT', '_USDT'));
      }

      let ratesFetched = false;
      try {
        if (exchangeName === 'okx') {
          for (const pair of adjustedPairs) {
            const response = await axios.get(`${config.rest_url_funding}?instId=${pair}`, { timeout: 5000 });
            const item = response.data.data[0];
            if (item && item.fundingRate != null) {
              collector.updateRate(exchangeName, item.instId, parseFloat(item.fundingRate));
              ratesFetched = true;
            }
          }
        } else {
          const response = await axios.get(config.rest_url_funding, { timeout: 5000 });
          const data = response.data;

          if (exchangeName === 'binance') {
            for (const item of data) {
              if (adjustedPairs.includes(item.symbol) && item.lastFundingRate != null) {
                collector.updateRate(exchangeName, item.symbol, parseFloat(item.lastFundingRate));
                ratesFetched = true;
              }
            }
          } else if (exchangeName === 'bybit') {
            for (const item of data.result.list) {
              if (adjustedPairs.includes(item.symbol) && item.fundingRate != null) {
                collector.updateRate(exchangeName, item.symbol, parseFloat(item.fundingRate));
                ratesFetched = true;
              }
            }
          } else if (exchangeName === 'bitget') {
            for (const item of data.data) {
              if (adjustedPairs.includes(item.symbol) && item.fundingRate != null) {
                collector.updateRate(exchangeName, item.symbol, parseFloat(item.fundingRate));
                ratesFetched = true;
              }
            }
          } else if (exchangeName === 'gate') {
            for (const item of data) {
              if (adjustedPairs.includes(item.contract) && item.funding_rate != null) {
                collector.updateRate(exchangeName, item.contract, parseFloat(item.funding_rate));
                ratesFetched = true;
              }
            }
          }
        }

        if (ratesFetched) {
          logger.info(`${exchangeName} 通过 REST 获取资金费率成功`);
          continue;
        }
      } catch (error) {
        logger.warn(`${exchangeName} REST 获取资金费率失败，尝试 WebSocket: ${error}`);
      }

      // 回退到 WebSocket
      await fetchFundingRatesViaWebSocket(exchangeName, config.ws_url, adjustedPairs, collector);
    } catch (error) {
      logger.error(`${exchangeName} 获取资金费率失败: ${error}`);
    }
  }
}

async function fetchFundingRatesViaWebSocket(
  exchangeName: string,
  wsUrl: string,
  pairs: string[],
  collector: FundingRateCollector
): Promise<void> {
  return new Promise((resolve) => {
    const ws = new WebSocket(wsUrl);
    let dataReceived = false;
    const timeout = setTimeout(() => {
      ws.close();
      resolve();
    }, exchangeName === 'gate' ? 15000 : 10000); // Gate 延长到 15 秒

    ws.on('open', () => {
      const subscribeMsgs = generateSubscribeMsg(exchangeName, pairs);
      for (const msg of subscribeMsgs) {
        try {
          ws.send(JSON.stringify(msg));
          logger.info(`${exchangeName} 发送订阅消息: ${JSON.stringify(msg)}`);
        } catch (error) {
          logger.error(`${exchangeName} 发送订阅消息失败: ${error}`);
        }
      }
    });

    ws.on('message', (data: Buffer) => {
      try {
        const parsed = JSON.parse(data.toString());
        const rates = parseFundingRate(exchangeName, parsed);
        for (const [symbol, rate] of rates) {
          if (symbol && rate != null && pairs.includes(symbol)) {
            collector.updateRate(exchangeName, symbol, rate);
            dataReceived = true;
            logger.info(`${exchangeName} 收到资金费率: ${symbol} -> ${rate}`);
          }
        }
      } catch (error) {
        logger.error(`解析 ${exchangeName} 消息失败: ${error}`);
      }
    });

    ws.on('error', (error) => {
      logger.error(`${exchangeName} WebSocket 错误: ${error}`);
    });

    ws.on('close', () => {
      clearTimeout(timeout);
      logger.info(`${exchangeName} WebSocket 关闭${dataReceived ? '，数据已获取' : '，无数据'}`);
      resolve();
    });
  });
}

function generateSubscribeMsg(exchangeName: string, symbols: string[]): any[] {
  const batchSize = 10;
  const batches: string[][] = [];
  for (let i = 0; i < symbols.length; i += batchSize) {
    batches.push(symbols.slice(i, i + batchSize)); // 修复语法错误
  }

  const configs: { [key: string]: (batch: string[]) => any } = {
    binance: (batch) => ({
      method: 'SUBSCRIBE',
      params: batch.map((s) => `${s.toLowerCase()}@markPrice`),
      id: 1,
    }),
    okx: (batch) => ({
      op: 'subscribe',
      args: batch.map((s) => ({ channel: 'funding-rate', instId: s })),
    }),
    bybit: (batch) => ({
      op: 'subscribe',
      args: batch.map((s) => `tickers.${s}`),
    }),
    bitget: (batch) => ({
      op: 'subscribe',
      args: batch.map((s) => ({ instType: 'USDT-FUTURES', channel: 'ticker', instId: s })),
    }),
    gate: (batch) => ({
      time: Math.floor(Date.now() / 1000),
      channel: 'futures.tickers',
      event: 'subscribe',
      payload: batch,
      id: 1,
    }),
  };

  return batches.map((batch) => configs[exchangeName]?.(batch) || {});
}

function parseFundingRate(exchangeName: string, data: any): [string | null, number | null][] {
  try {
    const parsers: { [key: string]: (d: any) => [string | null, number | null][] } = {
      binance: (d) =>
        d.e === 'markPriceUpdate' && d.s && d.r != null ? [[d.s, parseFloat(d.r)]] : [],
      okx: (d) =>
        d.arg?.channel === 'funding-rate' && d.data?.[0]?.fundingRate
          ? [[d.arg.instId, parseFloat(d.data[0].fundingRate)]]
          : [],
      bybit: (d) =>
        d.data?.symbol && d.data?.fundingRate != null
          ? [[d.data.symbol, parseFloat(d.data.fundingRate)]]
          : [],
      bitget: (d) =>
        d.arg?.channel === 'ticker' && d.data?.[0]?.fundingRate
          ? [[d.arg.instId, parseFloat(d.data[0].fundingRate)]]
          : [],
      gate: (d) =>
        d.event === 'update' && d.result
          ? d.result
              .filter((item: any) => item.contract && item.funding_rate != null)
              .map((item: any) => [item.contract, parseFloat(item.funding_rate)])
          : [],
    };
    return parsers[exchangeName]?.(data) || [];
  } catch (error) {
    logger.error(`解析 ${exchangeName} 数据出错: ${error}`);
    return [];
  }
}

export async function sendTelegramMessage(message: string): Promise<void> {
    const url = `https://api.telegram.org/bot${TELEGRAM_CONFIG.bot_token}/sendMessage`;
    try {
      const response = await axios.post(url, {
        chat_id: TELEGRAM_CONFIG.chat_id,
        text: message,
      });
      if (response.status !== 200) {
        logger.error(`Telegram 推送失败: ${response.data}`);
      } else {
        logger.info('Telegram 消息推送成功');
      }
    } catch (error) {
      logger.error(`Telegram 推送失败: ${error}`);
    }
  }