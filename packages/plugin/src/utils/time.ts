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
