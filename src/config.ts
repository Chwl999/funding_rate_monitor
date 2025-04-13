/**
 * @file config.ts
 * @description 负责加载和导出应用程序所需的配置信息。
 * 从环境变量、`config.json` 和 `exchanges_config.json` 文件中读取配置。
 */

import * as fs from 'fs'; // Node.js 内置的文件系统模块 (同步读取)
import { resolve } from 'path'; // Node.js 内置的路径处理模块
import dotenv from 'dotenv'; // 用于从 .env 文件加载环境变量

// 1. 加载 .env 文件中的环境变量 (例如 TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID)
// dotenv.config() 会读取项目根目录下的 .env 文件，并将其中的变量添加到 process.env
dotenv.config();

// 2. 加载主要的 JSON 配置文件
// 解析主配置文件 config.json 的绝对路径
const configPath = resolve(__dirname, '../config.json');
// 解析交易所特定配置文件 exchanges_config.json 的绝对路径
const exchangesConfigPath = resolve(__dirname, '../exchanges_config.json');

// 读取并解析主配置文件 config.json
// fs.readFileSync 同步读取文件内容
// JSON.parse 将读取到的字符串解析为 JavaScript 对象
export const CONFIG = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

/**
 * @const EXCHANGES
 * @description 存储各个交易所特定配置的对象。
 * 键是交易所的小写名称 (例如 'binance', 'okx')。
 * 值包含该交易所的 WebSocket URL、REST API URL、API 响应字段映射等信息。
 */
export const EXCHANGES: {
  [key: string]: { // 交易所名称
    ws_url: string; // WebSocket 连接地址
    rest_url_ticker?: string; // REST API 获取 Ticker (市场行情) 的地址 (可选)
    rest_url_funding: string; // REST API 获取资金费率的地址
    symbol_key: string; // API 响应中表示交易对名称的字段名
    volume_key?: string; // API 响应中表示交易量的字段名 (可选, 用于获取热门交易对)
    filter_suffix: string; // 用于筛选交易对的后缀 (例如 'USDT')
  };
} = JSON.parse(fs.readFileSync(exchangesConfigPath, 'utf-8')); // 读取并解析交易所配置文件

/**
 * @const TELEGRAM_CONFIG
 * @description 存储 Telegram Bot 相关配置。
 * 从环境变量 `process.env` 中读取。
 */
export const TELEGRAM_CONFIG = {
    bot_token: process.env.TELEGRAM_BOT_TOKEN, // Bot Token
    chat_id: process.env.TELEGRAM_CHAT_ID,     // 要发送消息的 Chat ID
  };

// 3. 从主配置 CONFIG 中导出常用的常量

/** @const TOP_PAIRS_COUNT 要获取的流动性最高的交易对数量 */
export const TOP_PAIRS_COUNT: number = CONFIG.top_pairs_count;

/** @const CACHE_DURATION 交易对列表缓存的有效期 (秒) */
export const CACHE_DURATION: number = CONFIG.cache_duration;

/** @const PUSH_INTERVAL 数据获取和推送的间隔时间 (秒) */
export const PUSH_INTERVAL: number = CONFIG.push_interval;

/** @const FILTER_NEGATIVE_DAILY_NET_RATE 是否过滤掉日净收益为负的套利机会 */
export const FILTER_NEGATIVE_DAILY_NET_RATE: boolean = CONFIG.filter_negative_daily_net_rate ?? false;

/** @const CACHE_FILE 交易对缓存文件的名称 */
export const CACHE_FILE: string = 'top_pairs_cache.json';

/**
 * @const TRANSACTION_FEE_PERCENT
 * @description 单边交易手续费率 (%)。
 * 优先尝试从 `config.json` 中的 `transaction_fee_percent` 字段读取。
 * 如果 `config.json` 中未定义该字段，则使用默认值 0.3%。
 * 使用空值合并运算符 (`??`) 来提供默认值。
 */
export const TRANSACTION_FEE_PERCENT: number = CONFIG.transaction_fee_percent ?? 0.3;