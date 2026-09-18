/**
 * 游戏订阅指令
 *
 * `#currency game`（列出, user 级） / `#currency game add|remove <游戏名...>`（admin 级）。
 * 订阅粒度是**游戏**——区服组合不是订阅对象, 由配置决定抓哪些 (见 CONTEXT.md)。
 *
 * `add` / `remove` 一次可跟**多个**游戏名, 以空格分隔:
 * `#currency game add 流放之路1 流放之路2 火炬之光`。切词是空白分隔的, 所以游戏名本身
 * 含空格时无解——这是指令层共有的前提, 不是本模块的选择。
 */

import type { OB11Message } from 'napcat-types/napcat-onebot';
import type { NapCatPluginContext } from 'napcat-types/napcat-onebot/network/plugin/types';
import type { UserRole } from '../../core/admin';
import { sessionKeyOf } from '../../core/session';
import { pluginState } from '../../core/state';
import { SessionStore } from '../../store/session.store';
import { sendReply } from '../utils';

/**
 * `game add <游戏名...>` 的取值校验
 *
 * 匹配对象是**运行期配置里的 `catalogs`**, 所以放不进声明式门槛, 走 `validateArgs`
 * (见 [ADR-0004](../../../../docs/adr/0004-pure-dispatch-with-validate-args.md))。
 * **精确匹配**: `流放之路` 不能命中 `流放之路1`, 否则用户以为订了 A 实际订的是 B。
 *
 * 多个游戏名**逐个校验, 有一个不合法就整条拒绝**, 不做"能订的订上、非法的报出来"。
 * 校验发生在 handler **之前**, 分发结果只有"执行 / 不执行"两态; 部分成功还会逼着用户
 * 对着回执逐项核对到底订上了哪些。整条拒绝的代价只是重打一次。
 *
 * @returns 出错的参数 (第一个不在 `catalogs` 里的游戏名; 空串表示一个都没给); `null` 表示通过
 */
export function validateGameNames(args: string[]): string | null {
    if (args.length === 0) return '';

    return (
        args.find((name) => !pluginState.config.catalogs.some((catalog) => catalog.name === name)) ??
        null
    );
}

/**
 * `game remove <游戏名...>` 的取值校验: 只要求至少跟一个游戏名
 *
 * **不校验 `catalogs`**(与 `add` 不同): 游戏一旦被从配置里删掉, 订阅它的会话就再也退不掉它,
 * 只能去手改文件。退订一个没订过的游戏因此是幂等的空操作, 如实回一句"未订阅"即可。
 *
 * 之所以要有这道校验: 缺参数时 `args` 是空数组, 落到 handler 里就是一条没有任何游戏名的
 * 回执。宁可让分发层回"非法参数", 也不要回一句看不懂的空话 (见 ADR-0002)。
 *
 * @returns 出错的参数 (空串表示一个都没给); `null` 表示通过
 */
export function validateRemovalTargets(args: string[]): string | null {
    return args.length > 0 ? null : '';
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

/** `#currency game add <游戏名...>`——订阅 (幂等: 重复订阅不报错) */
export async function gameAddHandler(
    ctx: NapCatPluginContext,
    event: OB11Message,
    commands: string[],
    userRole: UserRole,
): Promise<void> {
    // 游戏名已由分发层的 validateArgs 保证非空、且**每一个**都存在于 catalogs
    const gameNames = [...new Set(commands)];
    const sessionKey = sessionKeyOf(userRole.from);
    const store = SessionStore.getInstance();

    // 逐个写。每次 addGame 是一次读改写, 但指令是低频操作, 不值得为省几次磁盘往返
    // 把"批量订阅"扩进存储接口
    for (const gameName of gameNames) store.addGame(sessionKey, gameName);

    // 去重后再拼文案: `game add 火炬之光 火炬之光` 不该回一句"已订阅：火炬之光、火炬之光"
    await sendReply(ctx, event, `已订阅：${gameNames.join('、')}`);
}

/**
 * `#currency game remove <游戏名...>`——退订
 *
 * 不校验 `catalogs` 的理由见 `validateRemovalTargets`。
 *
 * 回执**分组如实报**: 一次退订多个时, "哪些退掉了"与"哪些本来就没订"是两个不同的事实,
 * 合并成一句"已取消订阅：A、B"会在 B 压根没订过时撒谎 (见 ADR-0002)。两行都为空不会发生
 * ——`validateRemovalTargets` 保证了至少有一个游戏名。
 */
export async function gameRemoveHandler(
    ctx: NapCatPluginContext,
    event: OB11Message,
    commands: string[],
    userRole: UserRole,
): Promise<void> {
    const sessionKey = sessionKeyOf(userRole.from);
    const store = SessionStore.getInstance();
    // 先取一份已订阅集合: 循环里每退一个都会重写文件, 边退边查会读到中间态
    const subscribed = new Set(store.getSession(sessionKey).enabledGames);

    const removed: string[] = [];
    const missing: string[] = [];
    for (const gameName of [...new Set(commands)]) {
        if (subscribed.has(gameName)) {
            store.removeGame(sessionKey, gameName);
            removed.push(gameName);
        } else {
            missing.push(gameName);
        }
    }

    const lines: string[] = [];
    if (removed.length > 0) lines.push(`已取消订阅：${removed.join('、')}`);
    if (missing.length > 0) lines.push(`未订阅：${missing.join('、')}`);

    await sendReply(ctx, event, lines.join('\n'));
}
