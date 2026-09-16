/**
 * 价格消息渲染
 *
 * 见设计文档 §10.2（消息模板）与 §12.3。**`price` 展示与定时推送共用本渲染器**——
 * 两处各写一份模板, 迟早会在改文案时漏掉一处, 表现是同一条数据在两个场景里长得不一样。
 *
 * ⚠️ 本模块是**纯函数**: 给数据、出文本, 不读全局状态、不发消息。
 */

import type { GameRecord } from '../store/data.store';
import { formatLocalTime } from '../utils/time';

/** 区服组合标题: `【国服 / 赛季 / 普通】`。**层数随配置自适应**, 不假设固定几级 */
function zoneTitle(zone: string[]): string {
    return `【${zone.join(' / ')}】`;
}

/**
 * 渲染一个游戏的价格块。
 *
 * 规则（§10.2）:
 * - 头部时间用**游戏级 `readAt`** 并转本地时区。区服级 `readAt` 留在数据文件里——
 *   同一轮内各区服只差几秒, 显示出来是噪音。
 * - **过滤掉 `price` 为 `0` 或 `null` 的行**, 在组合末尾交代数量。
 * - 整块都没取到时**仍显示标题**, 否则用户会以为这个区服没在抓。
 * - `missing`（配置的通货名在站点上不存在）**单独成行**: 被过滤掉的行在消息里看不见,
 *   这是配置写错时用户唯一的可见信号。
 */
export function renderGame(gameName: string, record: GameRecord): string {
    const lines = [`「${gameName}」${formatLocalTime(record.readAt)} 实时千岛通货价格`];

    for (const zone of record.zones) {
        lines.push('', zoneTitle(zone.zone));

        const visible = zone.prices.filter((price) => price.price !== null && price.price !== 0);

        visible.forEach((price, index) => {
            lines.push(`${index + 1}. ${price.name} ${price.price}${price.unit ? ` ${price.unit}` : ''}`);
        });

        const skipped = zone.prices.length - visible.length;
        if (skipped > 0) lines.push(`（${skipped} 项未取到价格）`);
    }

    if (record.missing.length > 0) {
        lines.push('', `（另有 ${record.missing.length} 项配置的通货名在站点上不存在）`);
    }

    return lines.join('\n');
}
