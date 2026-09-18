/**
 * 时间格式化
 *
 * ⚠️ **展示一律用本地时区**。数据文件里存的是 ISO 8601 UTC（便于比较与跨时区一致）,
 * 但用户看到的时间必须是他自己的钟点——直接把 UTC 串发给用户是最常见的时区错。
 */

/**
 * ISO 8601 时刻 → 本地 `YYYY-MM-DD HH:mm`
 *
 * 无法解析时**原样返回**而不是抛错或给个假时间: 展示层不该因为一条脏数据就炸掉整条消息。
 */
export function formatLocalTime(iso: string): string {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return iso;

    const pad = (value: number): string => String(value).padStart(2, '0');

    const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
    const clock = `${pad(date.getHours())}:${pad(date.getMinutes())}`;

    return `${day} ${clock}`;
}

/**
 * 计算 `now` 之后的**第一个「整点在选中集合里」**的时刻 (毫秒时间戳, 本地时间)。
 *
 * 见设计文档 §9.1。今天剩余的选中小时都用完了就顺延到明天第一个。
 *
 * ⚠️ 边界: `now` **恰好是选中整点**时返回**下一个**选中整点——必须**严格大于** `now`。
 * 用 `Math.ceil(...)` 按小时取整会把"现在"自己算进去, 退化成 `setTimeout(0)` 立刻
 * 再触发一次。
 *
 * `hours` 为空返回 `null`——空数组是合法语义（不定期触发）, 不是"回退默认全选"。
 * 乱序与重复的 `hours` 都合法, 内部去重排序。
 *
 * @param nowMs 当前时刻 (毫秒时间戳)
 * @param hours 选中的整点集合 (0-23 的本地小时)
 */
export function nextSelectedHour(nowMs: number, hours: number[]): number | null {
    const selected = [...new Set(hours)].filter(
        (hour) => Number.isInteger(hour) && hour >= 0 && hour <= 23,
    );
    if (selected.length === 0) return null;
    selected.sort((a, b) => a - b);

    const base = new Date(nowMs);

    // 今天 + 明天各扫一遍足够: 选中集合非空时, 明天的第一个选中小时必然命中
    for (let dayOffset = 0; dayOffset <= 1; dayOffset++) {
        for (const hour of selected) {
            const candidate = new Date(base);
            candidate.setDate(candidate.getDate() + dayOffset);
            candidate.setHours(hour, 0, 0, 0);

            if (candidate.getTime() > nowMs) return candidate.getTime();
        }
    }

    return null;
}
