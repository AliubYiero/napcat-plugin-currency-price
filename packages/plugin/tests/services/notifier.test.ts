/**
 * 通知层（片 09, §10.1 §10.3 §12.1 §12.3）
 *
 * 定时推送的**推送范围、渲染、串行**。抓取本身不在本片的范围内——推送层拿到的是
 * 「本轮哪些游戏失败了」和 `data.json` 里的数据。
 */

import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { DEFAULT_CONFIG } from '../../src/config';
import { pluginState } from '../../src/core/state';
import { pushToSubscribers } from '../../src/services/notifier';
import { SessionStore } from '../../src/store/session.store';
import {
    createTestEnv,
    seedGameResult,
    type TestEnv,
} from '../helpers/test-env';

let env: TestEnv;

const GAME_A = '流放之路2';
const GAME_B = '火炬之光';
const GAME_C = '流放之路1';

beforeEach(() => {
    vi.useFakeTimers();
    env = createTestEnv();
    env.init();

    pluginState.config = {
        ...DEFAULT_CONFIG,
        pushIntervalMs: 0,
        catalogs: [GAME_A, GAME_B].map((name) => ({
            name,
            pageUrl: `https://qiandao.com/${name}`,
            currencyList: [{ name: '神圣石', detail: false }],
            zoneConfigs: [['国服']],
        })),
    };
});

afterEach(() => {
    vi.useRealTimers();
    env.dispose();
});

/** 往 `data.json` 里塞一份成功数据（= 一次成功抓取留下的东西） */
function seed(
    gameName: string,
    readAt = '2026-09-16T08:00:05.123Z',
): void {
    seedGameResult(gameName, {
        readAt,
        missing: [],
        zones: [
            {
                zone: ['国服'],
                readAt,
                prices: [
                    { name: '神圣石', price: 0.2444, unit: '元/个' },
                ],
            },
        ],
    });
}

/** 让一个会话开通知并订阅若干游戏（顺序即传入顺序） */
function subscribe(sessionKey: string, games: string[]): void {
    const store = SessionStore.getInstance();
    store.setNotifyEnabled(sessionKey, true);
    for (const game of games) store.addGame(sessionKey, game);
}

/** 每条消息的头部（第一行） */
function headers(): string[] {
    return env.sentMessages.map(
        (sent) => sent.message.split('\n')[0],
    );
}

describe('pushToSubscribers — 推送范围与顺序', () => {
    it('一游戏一条消息, 按该会话的 `enabledGames` 顺序——**不是 `catalogs` 的顺序**', async () => {
        // catalogs 里流放之路2 在前; 会话订阅顺序刻意反过来
        subscribe('group:555', [GAME_B, GAME_A]);
        seed(GAME_A);
        seed(GAME_B);

        await pushToSubscribers();

        expect(headers()).toHaveLength(2);
        expect(headers()[0]).toContain(`「${GAME_B}」`);
        expect(headers()[1]).toContain(`「${GAME_A}」`);
    });
});

describe('pushToSubscribers — 「（数据未更新）」标记', () => {
    it('本轮失败的游戏推 `data.json` 里的**旧值**, 头部带「（数据未更新）」', async () => {
        subscribe('group:555', [GAME_A]);
        seed(GAME_A);

        await pushToSubscribers(new Set([GAME_A]));

        expect(headers()[0]).toContain('（数据未更新）');
        // 旧值照样推出来——标记本身已经是一种通知（§10.4）
        expect(env.sent[0]).toContain('神圣石 0.2444 元/个');
    });

    it('**因新鲜而跳过的不加标记**——那种情况数据是 5 分钟内的, 加了反而误导', async () => {
        subscribe('group:555', [GAME_A]);
        seed(GAME_A);

        // 本轮没抓任何游戏 = 全部因新鲜而跳过
        await pushToSubscribers();

        expect(env.sent).toHaveLength(1);
        expect(env.sent[0]).not.toContain('（数据未更新）');
    });

    it('同一轮里, 标记**只落在失败的那一个游戏**上', async () => {
        subscribe('group:555', [GAME_A, GAME_B]);
        seed(GAME_A);
        seed(GAME_B);

        await pushToSubscribers(new Set([GAME_B]));

        expect(headers()[0]).not.toContain('（数据未更新）');
        expect(headers()[1]).toContain('（数据未更新）');
    });
});

describe('pushToSubscribers — 推给谁', () => {
    it('只推给**开了通知**的会话——通知开关默认关闭', async () => {
        // 订阅了, 但没开通知
        SessionStore.getInstance().addGame('group:555', GAME_A);
        seed(GAME_A);

        await pushToSubscribers();

        expect(env.sent).toHaveLength(0);
    });

    it('**群与私聊各自独立收到**各自的订阅', async () => {
        subscribe('group:555', [GAME_A]);
        subscribe('private:10002', [GAME_B]);
        seed(GAME_A);
        seed(GAME_B);

        await pushToSubscribers();

        expect(env.sentMessages).toHaveLength(2);

        const toGroup = env.sentMessages.find(
            (sent) => sent.messageType === 'group',
        );
        const toPrivate = env.sentMessages.find(
            (sent) => sent.messageType === 'private',
        );

        expect(toGroup?.target).toBe('555');
        expect(toGroup?.message).toContain(`「${GAME_A}」`);
        expect(toPrivate?.target).toBe('10002');
        expect(toPrivate?.message).toContain(`「${GAME_B}」`);
    });
});

describe('pushToSubscribers — 没有可推的内容时静默', () => {
    it('**从未成功抓到过的游戏不发**——没有旧值可推', async () => {
        subscribe('group:555', [GAME_A]);

        await pushToSubscribers();

        expect(env.sent).toHaveLength(0);
    });

    it('全部游戏失败且都没有旧值 → **完全静默**, 不产生任何消息', async () => {
        subscribe('group:555', [GAME_A, GAME_B]);

        await pushToSubscribers(new Set([GAME_A, GAME_B]));

        expect(env.sent).toHaveLength(0);
    });
});

describe('pushToSubscribers — 串行与间隔', () => {
    it('**串行推送, 每条之间间隔 `pushIntervalMs`**', async () => {
        pluginState.config = {
            ...pluginState.config,
            pushIntervalMs: 200,
        };
        subscribe('group:555', [GAME_A, GAME_B, GAME_C]);
        for (const game of [GAME_A, GAME_B, GAME_C]) seed(game);

        const pending = pushToSubscribers();
        await vi.runAllTimersAsync();
        await pending;

        expect(env.sentMessages).toHaveLength(3);
        // 间隔加在**相邻两条之间**: 三条消息共两次等待; 最后一条之后不再空等
        const gap = (index: number): number =>
            env.sentMessages[index].sentAt -
            env.sentMessages[index - 1].sentAt;

        expect(gap(1)).toBe(200);
        expect(gap(2)).toBe(200);
    });
});
