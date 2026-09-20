/**
 * status 指令的端到端行为
 *
 * 见设计文档 §11.4。本片落定的四段: 通知开关 / 已订阅游戏 / 各游戏数据时间 / 浏览器状态行。
 * 「各游戏数据时间」的数据源 (`data.json`) 在片 03 落地, 本片一律显示"未抓取"——从未抓到过
 * 就是此刻的事实, 不是占位符。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../../../src/config';
import { pluginState } from '../../../src/core/state';
import { handleMessage } from '../../../src/handlers/message-handler';
import {
    detectBrowserLightweight,
    invalidateBrowserStatus,
} from '../../../src/services/browser/status';
import type { DetectOptions } from '../../../src/services/browser/launcher';
import {
    createTestEnv,
    groupMessage,
    privateMessage,
    type TestEnv,
} from '../../helpers/test-env';

let env: TestEnv;

const SUPER_ADMIN = '958341409';

/** 一台"有浏览器"的假机器 */
const WITH_CHROME: DetectOptions = {
    platform: 'linux',
    env: {},
    homeDir: '/home/napcat',
    isFile: (path) => path === '/usr/bin/chromium',
};

beforeEach(() => {
    env = createTestEnv();
    env.init();
    // 浏览器状态是模块级缓存, 会在用例之间残留——每个用例从不检测的干净状态开始
    invalidateBrowserStatus();
    pluginState.config = {
        ...DEFAULT_CONFIG,
        adminUsers: [SUPER_ADMIN],
        catalogs: ['流放之路2', '火炬之光'].map((name) => ({
            name,
            pageUrl: `https://qiandao.com/${name}`,
            currencyList: [{ name: '神圣石', detail: false }],
            zoneConfigs: [['国服', '赛季', '普通']],
        })),
    };
});

afterEach(() => {
    env.dispose();
});

async function send(
    event: Parameters<typeof handleMessage>[1],
): Promise<string> {
    env.clearSent();
    await handleMessage(env.ctx, event);

    return env.sent.at(-1) ?? '';
}

describe('status — 通知开关与已订阅游戏', () => {
    it('无订阅时如实说没有订任何游戏, 且不列出游戏数据行', async () => {
        expect(await send(groupMessage('#currency status'))).toBe(
            [
                '#currency 状态',
                '本群通知：已关闭',
                '已订阅游戏：（无）',
            ].join('\n'),
        );
    });

    it('有订阅时列出游戏, 并逐条给出该游戏的数据时间', async () => {
        await send(
            groupMessage('#currency notify on', { role: 'admin' }),
        );
        await send(
            groupMessage('#currency game add 流放之路2', {
                role: 'admin',
            }),
        );
        await send(
            groupMessage('#currency game add 火炬之光', {
                role: 'admin',
            }),
        );

        expect(await send(groupMessage('#currency status'))).toBe(
            [
                '#currency 状态',
                '本群通知：已开启',
                '已订阅游戏：流放之路2、火炬之光',
                '',
                '流放之路2：未抓取',
                '火炬之光：未抓取',
            ].join('\n'),
        );
    });

    it('**status 是本会话的**: 别的群订了游戏, 本群的状态里不出现', async () => {
        await send(
            groupMessage('#currency game add 流放之路2', {
                groupId: '555',
                role: 'admin',
            }),
        );

        expect(
            await send(
                groupMessage('#currency status', { groupId: '999' }),
            ),
        ).toContain('已订阅游戏：（无）');
    });

    it('私聊说"本会话通知"而不是"本群通知"', async () => {
        expect(
            await send(privateMessage('#currency status')),
        ).toContain('本会话通知：已关闭');
    });
});

describe('status — 浏览器行的可见性', () => {
    it('**只有「私聊 + superAdmin」看得到**浏览器状态行', async () => {
        const reply = await send(
            privateMessage('#currency status', {
                userId: SUPER_ADMIN,
                subType: 'friend',
            }),
        );

        expect(reply).toContain('浏览器：未检测');
    });

    it('超管在**群里**看不到: 那条信息是给部署者自己看的, 不该发到群里', async () => {
        const reply = await send(
            groupMessage('#currency status', {
                userId: SUPER_ADMIN,
                role: 'member',
            }),
        );

        expect(reply).not.toContain('浏览器');
    });

    it('好友私聊的普通用户看不到', async () => {
        const reply = await send(
            privateMessage('#currency status', { userId: '10002' }),
        );

        expect(reply).not.toContain('浏览器');
    });

    it('群管理员看不到, 群普通成员也看不到', async () => {
        expect(
            await send(
                groupMessage('#currency status', { role: 'admin' }),
            ),
        ).not.toContain('浏览器');
        expect(
            await send(groupMessage('#currency status')),
        ).not.toContain('浏览器');
    });
});

describe('status — 浏览器行接真实数据源', () => {
    async function statusForSuperAdmin(): Promise<string> {
        return send(
            privateMessage('#currency status', {
                userId: SUPER_ADMIN,
                subType: 'friend',
            }),
        );
    }

    it('检测过且可用 → 「浏览器：可用」', async () => {
        detectBrowserLightweight(WITH_CHROME);

        expect(await statusForSuperAdmin()).toContain('浏览器：可用');
    });

    it('检测过但不可用 → 「浏览器：不可用」', async () => {
        detectBrowserLightweight({
            ...WITH_CHROME,
            isFile: () => false,
        });

        expect(await statusForSuperAdmin()).toContain(
            '浏览器：不可用',
        );
    });

    it('**从未检测过时说「未检测」, 不谎报可用**——本条只对超管可见, 更不该糊弄', async () => {
        expect(await statusForSuperAdmin()).toContain(
            '浏览器：未检测',
        );
    });
});
