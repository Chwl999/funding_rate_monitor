import { FundingRateCollector } from './collector';
import { fetchTopLiquidityPairs, fetchFundingRates, sendTelegramMessage, logger } from './utils';
import { PUSH_INTERVAL } from './config';

async function main(): Promise<void> {
  const collector = new FundingRateCollector();
  let lastPairsUpdate = 0;

  while (true) {
    try {
      // 每小时更新交易对
      const now = Date.now() / 1000;
      let topPairs: string[];
      if (now - lastPairsUpdate >= 3600) {
        topPairs = await fetchTopLiquidityPairs();
        lastPairsUpdate = now;
        logger.info(`更新交易对: ${topPairs.length} 个`);
      } else {
        topPairs = await fetchTopLiquidityPairs();
      }

      if (!topPairs.length) {
        logger.warn('无交易对数据，等待下一次循环');
        await new Promise((resolve) => setTimeout(resolve, PUSH_INTERVAL * 1000));
        continue;
      }

      // 获取资金费率
      collector.clear();
      await fetchFundingRates(collector, topPairs);

      // 推送结果
      const message = collector.getArbitragePairs();
      await sendTelegramMessage(message);

      // 等待下一次推送
      await new Promise((resolve) => setTimeout(resolve, PUSH_INTERVAL * 1000));
    } catch (error) {
      logger.error(`主循环出错: ${error}`);
      await new Promise((resolve) => setTimeout(resolve, PUSH_INTERVAL * 1000));
    }
  }
}

if (require.main === module) {
  main().catch((error) => {
    logger.error('程序错误:', error);
    process.exit(1);
  });
}