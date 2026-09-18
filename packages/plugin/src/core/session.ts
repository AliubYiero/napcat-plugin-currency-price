/**
 * 会话与会话键
 *
 * 订阅的**主体是会话**（群聊或私聊二者之一），不是群、也不是用户——见 CONTEXT.md 的
 * 「会话 (session) 与 会话键 (session key)」。会话键是会话在 `state.json` 中的唯一标识,
 * 形如 `group:123456` / `private:789`。
 *
 * 键一律由 `UserRole['from']` 生成: 入口处已一次性推导过"这条消息来自哪个会话",
 * 此处不再重复解析消息事件。
 */

import type { UserRole } from './admin';

/**
 * 由会话来源生成会话键
 *
 * @param from `UserRole['from']`——id 是群号或 QQ 号
 */
export function sessionKeyOf(from: UserRole['from']): string {
    return `${from.type}:${from.id}`;
}

/** 会话键解析出的发送目标: 群号或 QQ 号 */
export interface SessionTarget {
    type: 'group' | 'private';
    /** 群号或 QQ 号 (字符串形式, 直接喂给发送接口) */
    id: string;
}

/**
 * 会话键 → 发送目标 (`sessionKeyOf` 的逆)
 *
 * 键是**用户可手改的磁盘内容**, 格式非法时返回 `null` 而不是抛错: 推送层据此跳过
 * 这一个会话, 不让一个手改坏的键拖垮整轮推送。
 */
export function parseSessionKey(sessionKey: string): SessionTarget | null {
    const separator = sessionKey.indexOf(':');
    if (separator <= 0) return null;

    const type = sessionKey.slice(0, separator);
    const id = sessionKey.slice(separator + 1);
    if ((type !== 'group' && type !== 'private') || id.length === 0) return null;

    return { type, id };
}

/**
 * 会话在**面向用户的文案**里的自称
 *
 * 群聊说"本群"、私聊说"本会话": 对着一个私聊会话说"本群通知"会让人以为自己发错了地方。
 * 只用于文案, 不参与任何判定。
 */
export function sessionScopeLabel(from: UserRole['from']): string {
    return from.type === 'group' ? '本群' : '本会话';
}
