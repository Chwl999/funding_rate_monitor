import * as fs from 'fs';
import { resolve } from 'path';
import dotenv from 'dotenv';

// 加载环境变量
dotenv.config();

// 加载配置文件
const configPath = resolve(__dirname, '../config.json');
const exchangesConfigPath = resolve(__dirname, '../exchanges_config.json');

export const CONFIG = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
export const EXCHANGES: {
  [key: string]: {
    ws_url: string;
    rest_url_ticker?: string;
    rest_url_funding: string;
    symbol_key: string;
    volume_key?: string;
    filter_suffix: string;
  };
} = JSON.parse(fs.readFileSync(exchangesConfigPath, 'utf-8'));

// Telegram 配置从环境变量读取
export const TELEGRAM_CONFIG = {
    bot_token: process.env.TELEGRAM_BOT_TOKEN,
    chat_id: process.env.TELEGRAM_CHAT_ID,
  };

// 常量
export const TOP_PAIRS_COUNT: number = CONFIG.top_pairs_count;
export const CACHE_DURATION: number = CONFIG.cache_duration;
export const PUSH_INTERVAL: number = CONFIG.push_interval;
export const CACHE_FILE: string = 'top_pairs_cache.json';

// 交易手续费率 (%)，尝试从 config.json 读取，否则默认为 0.3%
export const TRANSACTION_FEE_PERCENT: number = CONFIG.transaction_fee_percent ?? 0.3;