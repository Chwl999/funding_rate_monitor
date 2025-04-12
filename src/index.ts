/**
 * @file index.ts
 * @description 程序主入口文件，负责启动资金费率监控循环。
 */

// 导入必要的模块和工具函数
import { FundingRateCollector } from './collector'; // 资金费率数据收集器类
import { fetchTopLiquidityPairs, fetchFundingRates, sendTelegramMessage, logger } from './utils'; // 工具函数：获取交易对、获取费率、发送消息、日志记录器
import { PUSH_INTERVAL, TRANSACTION_FEE_PERCENT } from './config'; // 配置项：推送间隔、交易手续费率

/**
 * @function main
 * @description 程序的主函数，包含无限循环，用于定期获取和推送资金费率信息。
 */
async function main(): Promise<void> {
  // 创建资金费率收集器实例
  const collector = new FundingRateCollector();
  // 记录上次更新交易对列表的时间戳 (秒)
  let lastPairsUpdate = 0;

  // 无限循环，持续监控
  while (true) {
    try {
      // ----------- 1. 更新热门交易对列表 ----------- //
      const now = Date.now() / 1000; // 获取当前时间戳 (秒)
      let topPairs: string[]; // 存储热门交易对列表

      // 每隔 1 小时 (3600 秒) 或首次运行时，从交易所获取最新的热门交易对
      if (now - lastPairsUpdate >= 3600) {
        topPairs = await fetchTopLiquidityPairs(); // 调用工具函数获取交易对
        lastPairsUpdate = now; // 更新上次更新时间
        logger.info(`更新交易对: ${topPairs.length} 个`); // 记录日志
      } else {
        // 如果未到更新时间，则使用缓存的或上次获取的交易对列表
        topPairs = await fetchTopLiquidityPairs(); // 内部会处理缓存逻辑
      }

      // 如果未能获取到任何交易对，则记录警告并等待下一个周期
      if (!topPairs.length) {
        logger.warn('无交易对数据，等待下一次循环');
        await new Promise((resolve) => setTimeout(resolve, PUSH_INTERVAL * 1000)); // 等待 PUSH_INTERVAL 秒
        continue; // 跳过本次循环的后续步骤
      }

      // ----------- 2. 获取资金费率 ----------- //
      collector.clear(); // 清空上一轮收集的费率数据
      await fetchFundingRates(collector, topPairs); // 调用工具函数，获取 topPairs 的资金费率，并存入 collector

      // ----------- 3. 推送常规套利机会消息 ----------- //
      // 从 collector 获取格式化后的高正/负费率套利机会消息
      const message = collector.getArbitragePairs();
      // 将消息通过 Telegram 发送出去
      await sendTelegramMessage(message);

      // ----------- 4. 检查并推送跨交易所套利机会消息 (延迟执行) ----------- //
      // 使用 setTimeout 设置一个 2 秒后执行的任务
      setTimeout(async () => {
        try {
          // 调用 collector 获取跨交易所套利机会的消息
          const crossExchangeMessage = collector.getCrossExchangeArbitrageOpportunities(TRANSACTION_FEE_PERCENT);
          // 仅当 crossExchangeMessage 不为空 (即找到了套利机会) 时，才发送消息
          if (crossExchangeMessage) {
            await sendTelegramMessage(crossExchangeMessage);
            logger.info('发送跨交易所套利机会消息'); // 记录日志
          }
        } catch (error) {
          // 记录发送跨交易所套利消息时可能发生的错误
          logger.error(`发送跨交易所套利消息出错: ${error}`);
        }
      }, 2000); // 延迟 2000 毫秒 (2 秒)

      // ----------- 5. 等待下一个推送周期 ----------- //
      // 程序暂停 PUSH_INTERVAL 秒，然后开始下一轮循环
      await new Promise((resolve) => setTimeout(resolve, PUSH_INTERVAL * 1000));

    } catch (error) {
      // 捕获主循环中发生的任何未预料错误
      logger.error(`主循环出错: ${error}`);
      // 即使出错，也等待 PUSH_INTERVAL 秒后继续尝试下一轮循环，以增加程序的健壮性
      await new Promise((resolve) => setTimeout(resolve, PUSH_INTERVAL * 1000));
    }
  }
}

// ----------- 程序入口 ----------- //
// 判断当前模块是否是主模块 (即直接通过 node index.js 运行)
if (require.main === module) {
  // 调用 main 函数启动监控
  main().catch((error) => {
    // 捕获 main 函数启动时或运行过程中的致命错误
    logger.error('程序启动或运行时发生致命错误:', error);
    process.exit(1); // 异常退出程序
  });
}