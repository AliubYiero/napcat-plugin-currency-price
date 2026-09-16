/**
 * `@机器人` CQ 段剥离 (纯函数)
 *
 * 让 `@机器人 + 前缀指令` 也能触发, 由接收层在**群启用检查之后、前缀检查之前**
 * 按 `allowAtBotTrigger` 配置调用。
 *
 * ⚠️ 本函数**只负责剥离**: 不整体 `trim()`、不 `trimStart()`、不产生任何日志副作用。
 * 规范化三步 (`trim()` → `stripAtBotPrefix` → `trimStart()`) 的编排是接收层的职责。
 */

/** 匹配消息开头的一条 at CQ 段, 捕获其 `qq` 属性值 */
const LEADING_AT_CQ = /^\s*\[cq:at\b([^\]]*)\]/i;

/**
 * 从一段 CQ 段属性串里取出 `qq` 的值。
 *
 * 容忍: 单引号 / 双引号 / 无引号; 属性顺序不限; 允许额外属性 (如 `name=...`)。
 *
 * @returns `qq` 的原始值; 没有 `qq` 属性时返回 `null`
 */
function readQqAttribute(attributes: string): string | null {
    const match = /(?:^|,)\s*qq\s*=\s*(?:"([^"]*)"|'([^']*)'|([^,\]]*))/i.exec(attributes);
    if (!match) return null;

    return (match[1] ?? match[2] ?? match[3] ?? '').trim();
}

/**
 * 剥离开头的第一个匹配 `selfId` 的 at CQ 段
 *
 * - 只剥离**第一个**; at 的是别人、或 at 段不在开头时原样返回。
 * - `qq` 值必须**精确等于** `selfId` 的字符串形式 (前缀相同不算命中)。
 * - `selfId` 缺失 / 为空 / 类型无效时跳过剥离, 原样返回; 不抛异常。
 *
 * @param rawMessage 原始消息串 (调用方已完成整体 `trim()`)
 * @param selfId 机器人自身 QQ 号, 取自 `PluginState.selfId`, **不硬编码**
 */
export function stripAtBotPrefix(rawMessage: string, selfId: string): string {
    if (typeof rawMessage !== 'string') return rawMessage;
    // selfId 无效时直接放弃剥离, 保持原消息继续前缀检查
    if (typeof selfId !== 'string' || selfId.length === 0) return rawMessage;

    const match = LEADING_AT_CQ.exec(rawMessage);
    if (!match) return rawMessage;

    const qq = readQqAttribute(match[1] ?? '');
    if (qq === null || qq !== selfId) return rawMessage;

    return rawMessage.slice(match[0].length);
}
