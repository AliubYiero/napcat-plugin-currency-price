/**
 * 游戏订阅指令
 *
 * `#currency game`（列出, user 级） / `#currency game add|remove <游戏名>`（admin 级）。
 * 订阅粒度是**游戏**——区服组合不是订阅对象, 由配置决定抓哪些 (见 CONTEXT.md)。
 */

import type { OB11Message } from 'napcat-types/napcat-onebot';
import type { NapCatPluginContext } from 'napcat-types/napcat-onebot/network/plugin/types';
import type { UserRole } from '../../core/admin';
import { sessionKeyOf } from '../../core/session';
import { pluginState } from '../../core/state';
import { SessionStore } from '../../store/session.store';
import { sendReply } from '../utils';

/**
 * `game add <游戏名>` 的取值校验
 *
 * 匹配对象是**运行期配置里的 `catalogs`**, 所以放不进声明式门槛, 走 `validateArgs`
 * (见 [ADR-0004](../../../../docs/adr/0004-pure-dispatch-with-validate-args.md))。
 * **精确匹配**: `流放之路` 不能命中 `流放之路1`, 否则用户以为订了 A 实际订的是 B。
 *
 * @returns 出错的参数; `null` 表示通过
 */
export function validateGameName(args: string[]): string | null {
    if (args.length > 1) return args[1] ?? '';
    const name = args[0];
    if (!name) return '';

    return pluginState.config.catalogs.some((catalog) => catalog.name === name) ? null : name;
}

/** `#currency game`——列出配置中的游戏, 标出本会话已订阅的 */
export async function gameListHandler(
    ctx: NapCatPluginContext,
    event: OB11Message,
    _commands: string[],
    userRole: UserRole,
): Promise<void> {
    const { commandPrefix, catalogs } = pluginState.config;
    const { enabledGames } = SessionStore.getInstance().getSession(sessionKeyOf(userRole.from));

    const lines = [`${commandPrefix} 可订阅的游戏`];
    if (catalogs.length === 0) {
        lines.push('（未配置任何游戏）');
    } else {
        for (const catalog of catalogs) {
            // 标出已订阅的: 用户来这条指令就是为了看"我订了哪些 / 还能订哪些"
            const mark = enabledGames.includes(catalog.name) ? '（已订阅）' : '';
            lines.push(`- ${catalog.name}${mark}`);
        }
    }

    await sendReply(ctx, event, lines.join('\n'));
}

/** `#currency game add <游戏名>`——订阅 (幂等: 重复订阅不报错) */
export async function gameAddHandler(
    ctx: NapCatPluginContext,
    event: OB11Message,
    commands: string[],
    userRole: UserRole,
): Promise<void> {
    // 游戏名已由分发层的 validateArgs 保证非空且存在于 catalogs
    const gameName = commands[0] as string;
    SessionStore.getInstance().addGame(sessionKeyOf(userRole.from), gameName);

    await sendReply(ctx, event, `已订阅：${gameName}`);
}

/**
 * `#currency game remove <游戏名>`——退订
 *
 * **不校验 `catalogs`**(与 `add` 不同): 游戏一旦被从配置里删掉, 订阅它的会话就再也退不掉它,
 * 只能去手改文件。退订一个没订过的游戏因此是幂等的空操作, 如实回一句"未订阅"即可。
 */
export async function gameRemoveHandler(
    ctx: NapCatPluginContext,
    event: OB11Message,
    commands: string[],
    userRole: UserRole,
): Promise<void> {
    const gameName = commands[0] as string;
    const sessionKey = sessionKeyOf(userRole.from);
    const store = SessionStore.getInstance();
    const subscribed = store.getSession(sessionKey).enabledGames.includes(gameName);

    if (subscribed) store.removeGame(sessionKey, gameName);

    await sendReply(ctx, event, subscribed ? `已取消订阅：${gameName}` : `未订阅：${gameName}`);
}
