/**
 * 由 pnpm run help:generate 生成, 禁止手改
 * cmd 权威源: scripts/generateHelp/cmds/napcat-plugin-currency-price.ts
 */

import type { HelpVariant } from '../../utils/helpMessage';

/** 按帮助版本的文本帮助 (图片降级用), Admin 版同时用于私聊用户与群聊超管 */
export const HELP_TEXT_MAP: Record<HelpVariant, string> = {
    user: "【千岛通货价格 插件帮助】\n\n核心指令:\n#currency price: 获取游戏通货价格数据, 然后展示本会话订阅的全部游戏通货价格\n\n辅助指令:\n#currency help: 显示本帮助\n#currency status: 查看本会话的通知开关、已订阅游戏与各游戏数据时间\n",
    admin: "【千岛通货价格 插件帮助】\n\n核心指令:\n#currency price: 获取游戏通货价格数据, 然后展示本会话订阅的全部游戏通货价格\n\n辅助指令:\n#currency help: 显示本帮助\n#currency status: 查看本会话的通知开关、已订阅游戏与各游戏数据时间\n\n管理指令 [管理员]:\n#currency notify on: 开启本会话定时价格通知\n#currency notify off: 关闭本会话定时价格通知\n#currency game add <游戏名...>: 订阅游戏 (可空格分隔多个)\n#currency game remove <游戏名...>: 退订游戏 (可空格分隔多个)\n",
    superAdmin: "【千岛通货价格 插件帮助】\n\n核心指令:\n#currency price: 获取游戏通货价格数据, 然后展示本会话订阅的全部游戏通货价格\n\n辅助指令:\n#currency help: 显示本帮助\n#currency status: 查看本会话的通知开关、已订阅游戏与各游戏数据时间\n\n管理指令 [管理员]:\n#currency notify on: 开启本会话定时价格通知\n#currency notify off: 关闭本会话定时价格通知\n#currency game add <游戏名...>: 订阅游戏 (可空格分隔多个)\n#currency game remove <游戏名...>: 退订游戏 (可空格分隔多个)\n",
};
