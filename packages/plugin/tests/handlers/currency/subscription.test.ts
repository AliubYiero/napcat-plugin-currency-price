/**
 * 订阅指令的端到端行为
 *
 * 从**真实入口** `handleMessage` 走起: 前缀检查 → 切词 → 分发 → 权限/取值校验 → handler
 * → 发送。断言的是"用户发出什么、机器人回什么、磁盘上留下什么"——不碰任何内部结构。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../../../src/config';
import { pluginState } from '../../../src/core/state';
import { handleMessage } from '../../../src/handlers/message-handler';
import {
    createTestEnv,
    groupMessage,
    privateMessage,
    readStateFile,
    type TestEnv,
} from '../../helpers/test-env';

let env: TestEnv;

const CATALOG_NAMES = ['流放之路2', '流放之路1', '火炬之光'];

beforeEach(() => {
    env = createTestEnv();
    env.init();
    pluginState.config = {
        ...DEFAULT_CONFIG,
        catalogs: CATALOG_NAMES.map((name) => ({
            name,
            pageUrl: `https://qiandao.com/${name}`,
            currencyList: ['神圣石'],
            zoneConfigs: [['国服', '赛季', '普通']],
        })),
    };
});

afterEach(() => {
    env.dispose();
});

/** 发一条消息, 返回机器人回的**最后一条**消息文本 */
async function send(event: Parameters<typeof handleMessage>[1]): Promise<string> {
    env.clearSent();
    await handleMessage(env.ctx, event);

    return env.sent.at(-1) ?? '';
}

describe('notify — 查看与开关', () => {
    it('`notify`（不带参数）回显当前开关状态: 默认关闭', async () => {
        const reply = await send(groupMessage('#currency notify'));

        expect(reply).toBe('本群通知：已关闭');
    });

    it('群管理员 `notify on` 后回显已开启, 且再查看仍是已开启', async () => {
        expect(await send(groupMessage('#currency notify on', { role: 'admin' }))).toBe(
            '本群通知：已开启',
        );

        expect(await send(groupMessage('#currency notify'))).toBe('本群通知：已开启');
    });

    it('`notify off` 关回去', async () => {
        await send(groupMessage('#currency notify on', { role: 'admin' }));

        expect(await send(groupMessage('#currency notify off', { role: 'admin' }))).toBe(
            '本群通知：已关闭',
        );
    });

    it('开关落盘: 重载插件后仍是已开启', async () => {
        await send(groupMessage('#currency notify on', { role: 'admin' }));

        const reloaded = createTestEnv(env.root);
        reloaded.init();
        env.clearSent();
        await handleMessage(reloaded.ctx, groupMessage('#currency notify'));
        expect(reloaded.sent.at(-1)).toBe('本群通知：已开启');
        reloaded.dispose();
    });

    it('**权限不足**: 群普通成员 `notify on` 收到权限不足文案, 且开关没被改动', async () => {
        const reply = await send(groupMessage('#currency notify on'));

        expect(reply).toContain('权限不足');
        expect(reply).toContain('#currency');
        // 订阅关系一个字节都没落盘——被挡下的指令不该在磁盘上留痕
        expect(readStateFile(env)).toBeNull();
        expect(await send(groupMessage('#currency notify'))).toBe('本群通知：已关闭');
    });

    it('好友私聊是 privateUser: 说"本会话通知"而不是"本群通知"', async () => {
        expect(await send(privateMessage('#currency notify on'))).toBe('本会话通知：已开启');
    });

    it('**群的开关不影响私聊, 私聊的也不影响群**', async () => {
        await send(groupMessage('#currency notify on', { groupId: '555', role: 'admin' }));

        expect(await send(privateMessage('#currency notify', { userId: '789' }))).toBe(
            '本会话通知：已关闭',
        );
        expect(await send(groupMessage('#currency notify', { groupId: '999' }))).toBe(
            '本群通知：已关闭',
        );
    });
});

describe('game — 列出、订阅与退订', () => {
    it('`game` 列出配置中的全部游戏, 一个都没订时不标任何标记', async () => {
        expect(await send(groupMessage('#currency game'))).toBe(
            ['#currency 可订阅的游戏', '- 流放之路2', '- 流放之路1', '- 火炬之光'].join('\n'),
        );
    });

    it('`game add 流放之路2` 后再列出, 该游戏被标为已订阅', async () => {
        expect(await send(groupMessage('#currency game add 流放之路2', { role: 'admin' }))).toBe(
            '已订阅：流放之路2',
        );

        expect(await send(groupMessage('#currency game'))).toBe(
            ['#currency 可订阅的游戏', '- 流放之路2（已订阅）', '- 流放之路1', '- 火炬之光'].join(
                '\n',
            ),
        );
    });

    it('订阅落盘: 重载插件后仍然订着', async () => {
        await send(groupMessage('#currency game add 流放之路2', { role: 'admin' }));

        const reloaded = createTestEnv(env.root);
        reloaded.init();
        reloaded.clearSent();
        await handleMessage(reloaded.ctx, groupMessage('#currency game'));
        expect(reloaded.sent.at(-1)).toContain('- 流放之路2（已订阅）');
        reloaded.dispose();
    });

    it('`game remove 火炬之光` 退订一个**没订过**的游戏: 如实说未订阅, 不报错', async () => {
        const reply = await send(groupMessage('#currency game remove 火炬之光', { role: 'admin' }));

        expect(reply).toBe('未订阅：火炬之光');
        expect(await send(groupMessage('#currency game'))).not.toContain('已订阅）');
    });

    it('退订已订阅的游戏', async () => {
        await send(groupMessage('#currency game add 火炬之光', { role: 'admin' }));

        expect(await send(groupMessage('#currency game remove 火炬之光', { role: 'admin' }))).toBe(
            '已取消订阅：火炬之光',
        );
        expect(await send(groupMessage('#currency game'))).not.toContain('已订阅）');
    });

    it('**非法参数**: `game add 原神` 回非法参数文案, 且没有订阅任何东西', async () => {
        const reply = await send(groupMessage('#currency game add 原神', { role: 'admin' }));

        expect(reply).toContain('非法参数 原神');
        expect(readStateFile(env)).toBeNull();
    });

    it('**权限不足**: 群普通成员 `game add` 订不了, 磁盘上不留痕迹', async () => {
        const reply = await send(groupMessage('#currency game add 流放之路2'));

        expect(reply).toContain('权限不足');
        expect(readStateFile(env)).toBeNull();
    });

    it('**订阅互相独立**: 群里订的不进私聊, 别的群也看不到', async () => {
        await send(groupMessage('#currency game add 流放之路2', { groupId: '555', role: 'admin' }));
        await send(privateMessage('#currency game add 火炬之光', { userId: '789' }));

        expect(await send(groupMessage('#currency game', { groupId: '555' }))).toContain(
            '- 流放之路2（已订阅）',
        );
        expect(await send(privateMessage('#currency game', { userId: '789' }))).toContain(
            '- 火炬之光（已订阅）',
        );
        expect(await send(groupMessage('#currency game', { groupId: '999' }))).not.toContain(
            '已订阅）',
        );
    });
});
