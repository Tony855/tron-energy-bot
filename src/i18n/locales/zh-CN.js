'use strict';
module.exports = {
  // 命令菜单
  'cmd.start':        '🏠 主菜单',
  'cmd.balance':      '💰 我的余额',
  'cmd.wallets':      '🎧 监听管理',
  'cmd.addwallet':    '➕ 添加监听地址',
  'cmd.deposit':      '📥 获取充值地址',
  'cmd.withdraw':     '📤 提交提现申请',
  'cmd.transactions': '🧾 最近交易',
  'cmd.status':       '📡 监听状态',
  'cmd.report':       '📊 今日简报',
  'cmd.referral':     '🎁 邀请好友',
  'cmd.help':         '❔ 使用帮助',
  'cmd.language':     '🌐 语言设置',

  // 主菜单
  'menu.wallets':      '🎧 监听管理',
  'menu.balance':      '💰 余额查询',
  'menu.deposit':      '📥 充值地址',
  'menu.withdraw':     '📤 提现申请',
  'menu.transactions': '🧾 交易记录',
  'menu.status':       '📡 监听状态',
  'menu.report':       '📊 今日简报',
  'menu.energy':       '⚡ 能量服务',
  'menu.referral':     '🎁 邀请好友',
  'menu.help':         '❔ 使用帮助',
  'menu.miniapp':      '▣ 打开监听控制台',

  // 通用返回
  'menu.home':         '🏠 返回主菜单',
  'menu.home_short':   '🏠 主菜单',
  'menu.cancel':       '✖️ 取消操作',

  // 监听管理子菜单
  'wallet.title':      '🎧 <b>监听管理</b>',
  'wallet.hint':       '监控为只读功能，不会要求私钥。',
  'wallet.empty':      '暂无启用的地址，请先添加监控地址。',
  'wallet.add':        '➕ 添加监听地址',
  'wallet.balance':    '🔎 查询余额',
  'wallet.history':    '📜 历史记录',
  'wallet.disable':    '🗑 停用地址',
  'wallet.disabled':   '♻️ 已停用地址',
  'wallet.back':       '↩️ 返回监听管理',

  // 首页
  'home.guest':        '顾客',
  'home.greeting':     '👋 欢迎回来，{name}！',
  'home.balance':      '💰 可用余额：<b>{balance} USDT</b>',
  'home.prompt':       '请选择下面的服务。',
  'home.security':     '🔐 请勿发送助记词、私钥或验证码。',

  // 语言选择

  // 内容页
  'content.deposit.title': '📥 <b>你的专属充值地址</b>',
  'content.deposit.net':   '网络：TRON 主网\n币种：USDT-TRC20',
  'content.deposit.warn':  '⚠️ 仅发送指定合约的 USDT。到账识别后仍需链上核验与管理员审核。',

  'content.withdraw.title': '📤 <b>提现申请</b>',
  'content.withdraw.howto': '请按以下格式发送：金额 空格 收款TRON地址',
  'content.withdraw.ex':    '例如：<code>10 Txxxx...</code>',
  'content.withdraw.note':  '提交后进入管理员审核，不会立即链上转账。',

  'content.tx.title': '🧾 <b>最近交易（最多 10 笔）</b>',
  'content.tx.empty': '暂无已识别交易。事件源未配置或未推送时，这里不会自动出现新交易。',

  'content.status.title': '📡 <b>监听状态</b>',
  'content.status.addr':  '启用地址：{count}',
  'content.status.last':  '最近事件：{last}',
  'content.status.24h':   '近 24 小时交易：{count}',
  'content.status.note':  '实时发现依赖管理员配置的第三方 TRON 事件推送服务。',

  'content.report.title':  '📊 <b>今日简报（UTC）</b>',
  'content.report.addr':   '监听地址：{count}',
  'content.report.events': '识别交易事件：{count}',
  'content.report.trx':    'TRX 转账合计：{amount} TRX',
  'content.report.usdt':   'USDT 转账合计：{amount} USDT',
  'content.report.note':   '注：收/转方向均计入统计。',

  'content.referral.title':   '🎁 <b>邀请好友</b>',
  'content.referral.count':   '已邀请：{count} 人',
  'content.referral.percent': '返佣比例：{percent}%（以系统规则为准）',
  'content.referral.link':    '你的专属链接：',

  'content.energy.title': '⚡ <b>能量服务</b>',
  'content.energy.body1': '真实能量供应商尚未接入，因此目前不能报价、扣款或声称委托成功。',
  'content.energy.body2': '供应商接入后此处将提供能量报价、时长选择、确认订单和订单状态。',

  'content.help.title': '❓ <b>帮助中心</b>',
  'content.help.l1': '🎧 监听管理：绑定公开地址进行只读监控',
  'content.help.l2': '📥 充值：获取系统分配的专属地址',
  'content.help.l3': '📤 提现：提交申请，等待管理员审核',
  'content.help.l4': '🧾 交易记录：查看已识别的链上事件',
  'content.help.l5': '📡 监听状态：查看最近事件接收情况',
  'content.help.security': '🔐 永远不要向机器人发送助记词、私钥或验证码。',

  'content.balance.title':  '💰 <b>我的余额</b>',
  'content.balance.amount': '可用余额：<b>{balance} USDT</b>',
  'content.balance.note':   '提现需提交申请并通过管理员审核。',

  'lang.title':       '🌐 <b>语言设置</b>\n\n请选择界面语言：',
  'lang.changed':     '✅ 已切换为中文',
  'lang.current':     '当前语言：中文',
  'lang.cancel':      '取消',

  // 子菜单按钮
  'wallet.back_home':   '↩️ 返回监听管理',
  'deposit.withdraw':   '📤 申请提现',
  'balance.deposit':    '📥 充值',
  'tx.refresh':         '🔄 刷新',
  'wallet.rm_confirm':  '⚠️ 确认停用',
  'wallet.del_confirm': '⚠️ 确认永久删除',
  'wallet.delete':      '🗑 删除',
  'wallet.restore':     '♻️ 恢复',
  'wallet.history_in':  '📥 收款记录',
  'wallet.history_out': '📤 付款记录',
  'wallet.in_short':    '📥 收款',
  'wallet.out_short':   '📤 付款',
  'wallet.other':       '🔎 其他地址',
  'wallet.detail':      '🔎 地址详情',
  'wallet.choose_other':'↩️ 选择其他地址',
  'wallet.cancel':      '✖️ 取消',
};
