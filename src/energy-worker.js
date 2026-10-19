const { query } = require('./db');
const { notifyUser } = require('./notifier'); // 假设你有这个通知模块

// 这里伪代码演示如何对接供应商
async function callProviderAPI(order) {
  // 在 .env 中配置 ENERGY_PROVIDER_API_KEY
  // 例如调用 Feee.io 的接口去租能量
  // const res = await fetch('https://api.provider.com/rent', ...);
  // return { success: true, txHash: '0x...' };
  return { success: false, error: 'Supplier not configured' };
}

async function processPendingOrders() {
  try {
    // 1. 找出 10 分钟内处于 pending 的订单
    const pendingOrders = await query(`
      SELECT * FROM energy_orders 
      WHERE status = 'pending' AND created_at > NOW() - INTERVAL 10 MINUTE
    `);

    for (const order of pendingOrders) {
      console.log(`[Worker] 处理订单 #${order.id}...`);
      
      try {
        const result = await callProviderAPI(order);
        
        if (result.success) {
          // 供应商下单成功，更新数据库并扣除用户余额
          await query('UPDATE energy_orders SET status = ?, tx_hash = ? WHERE id = ?', ['completed', result.txHash, order.id]);
          await query('UPDATE users SET balance = balance - ? WHERE id = ?', [order.quoted_price, order.user_id]);
          await notifyUser(order.user_id, `✅ 能量租赁成功！订单 #${order.id} 已到账。`);
          console.log(`[Worker] 订单 #${order.id} 成功发能量。`);
        } else {
          // 供应商失败，自动退款
          console.log(`[Worker] 订单 #${order.id} 供应商失败，开始退款...`);
          await query('UPDATE users SET balance = balance + ? WHERE id = ?', [order.quoted_price, order.user_id]);
          await query('UPDATE energy_orders SET status = ? WHERE id = ?', ['refunded', order.id]);
          await notifyUser(order.user_id, `⚠️ 抱歉，能量租赁暂时不可用，订单 #${order.id} 已全额退款。`);
        }
      } catch (err) {
        console.error(`[Worker] 订单 #${order.id} 处理异常:`, err);
      }
    }
  } catch (err) {
    console.error('[Worker] 扫描任务失败:', err);
  }
}

// 启动定时任务，每 30 秒扫描一次
function startWorker() {
  console.log('[Energy Worker] 启动中... 每30秒扫描一次 pending 订单。');
  setInterval(processPendingOrders, 30000);
}

module.exports = { startWorker };
