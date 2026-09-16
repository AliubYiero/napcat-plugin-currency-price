/**
 * `price` 指令
 *
 * 见设计文档 §12.2 与 §12.3。本片落定的是**手动刷新的前半段**: 什么时候直接回
 * 「服务不可用」、什么时候先回执「正在抓取…」、以及抓完怎么展示。
 *
 * 新鲜度（只重抓过期的）与互斥锁在片 05, 归档在片 07——本片的 `price` 会抓**全部**
 * 订阅游戏。这不是"简化实现", 是这一步的范围边界。
 *
 * 抓取要起浏览器, 因此在这里注入假抓取器: 本项目其余测试都跑真实实现, 但"起一个
 * 浏览器去访问站点"显然不该出现在单测里。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../../../src/config';
import { pluginState } from '../../../src/core/state';
import { handleMessage } from '../../../src/handlers/message-handler';
import { priceHandlerDeps } from '../../../src/handlers/currency/price.handler';
import { detectBrowserLightweight, invalidateBrowserStatus } from '../../../src/services/browser/status';
import type { DetectOptions } from '../../../src/services/browser/launcher';
import { createTestEnv, groupMessage, type TestEnv } from '../../helpers/test-env';

let env: TestEnv;

/** 一台"有浏览器"的假机器 */
const WITH_CHROME: DetectOptions = {
    platform: 'linux',
    env: {},
    homeDir: '/home/napcat',
    isFile: (path) => path === '/usr/bin/chromium',
};

/** 一台"一个浏览器都没有"的假机器 */
const WITHOUT_CHROME: DetectOptions = { ...WITH_CHROME, isFile: () => false };

const realScrape = priceHandlerDeps.scrape;

beforeEach(() => {
    env = createTestEnv();
    env.init();
    invalidateBrowserStatus();
    priceHandlerDeps.scrape = realScrape;

    pluginState.config = {
        ...DEFAULT_CONFIG,
        catalogs: ['流放之路2', '火炬之光'].map((name) => ({
            name,
            pageUrl: `https://qiandao.com/${name}`,
            currencyList: ['神圣石'],
            zoneConfigs: [['国服']],
        })),
    };
    detectBrowserLightweight(WITH_CHROME);
});

afterEach(() => {
    priceHandlerDeps.scrape = realScrape;
    env.dispose();
});

async function send(event: Parameters<typeof handleMessage>[1]): Promise<string> {
    env.clearSent();
    await handleMessage(env.ctx, event);

    return env.sent.at(-1) ?? '';
}

/** 回执「正在抓取…」会先发一条, 取最后一条即为结果 */
async function sendAll(event: Parameters<typeof handleMessage>[1]): Promise<string[]> {
    env.clearSent();
    await handleMessage(env.ctx, event);

    return [...env.sent];
}

describe('price — 服务不可用', () => {
    it('`catalogs` 为空 → 「服务不可用，请联系机器人管理员」', async () => {
        pluginState.config = { ...pluginState.config, catalogs: [] };

        expect(await send(groupMessage('#currency price'))).toBe('服务不可用，请联系机器人管理员');
    });

    it('**浏览器不可用** → 同一句「服务不可用，请联系机器人管理员」', async () => {
        detectBrowserLightweight(WITHOUT_CHROME);

        expect(await send(groupMessage('#currency price'))).toBe('服务不可用，请联系机器人管理员');
    });

    it('服务不可用时**不去抓取**——起一次注定失败的浏览器没有意义', async () => {
        let called = 0;
        priceHandlerDeps.scrape = async () => {
            called++;

            return {};
        };
        detectBrowserLightweight(WITHOUT_CHROME);

        await send(groupMessage('#currency price'));

        expect(called).toBe(0);
    });
});

/** 造一份成功的抓取结果 */
function okResult() {
    return {
        readAt: '2026-09-16T08:00:05.123Z',
        missing: [] as string[],
        zones: [
            {
                zone: ['国服', '赛季', '普通'],
                readAt: '2026-09-16T08:00:05.123Z',
                prices: [{ name: '神圣石', price: 0.2444, unit: '元/个' }],
            },
        ],
    };
}

/** 订阅一个游戏, 并把抓取结果固定下来 */
async function subscribeAndStub(gameName: string, result: ReturnType<typeof okResult>): Promise<void> {
    await send(groupMessage(`#currency game add ${gameName}`, { role: 'admin' }));
    priceHandlerDeps.scrape = async () => ({ [gameName]: result });
}

describe('price — 抓取与展示', () => {
    it('**先回执「正在抓取…」**, 抓完再发结果（抓取要跑几十秒, 用户需要知道指令被收到了）', async () => {
        await subscribeAndStub('流放之路2', okResult());

        const messages = await sendAll(groupMessage('#currency price'));

        expect(messages).toHaveLength(2);
        expect(messages[0]).toBe('正在抓取…');
    });

    it('展示价格与单位（单位由页面的「计价单位 / 基准单位」拼成）', async () => {
        await subscribeAndStub('流放之路2', okResult());

        const reply = await send(groupMessage('#currency price'));

        expect(reply).toContain('流放之路2');
        expect(reply).toContain('【国服 / 赛季 / 普通】');
        expect(reply).toContain('神圣石 0.2444 元/个');
    });

    it('抓取结果**落盘到 `data.json`**——下次展示才能复用', async () => {
        await subscribeAndStub('流放之路2', okResult());

        await send(groupMessage('#currency price'));

        const data = JSON.parse(env.readDataFile('data.json') ?? '{}');

        expect(data.games['流放之路2'].readAt).toBe('2026-09-16T08:00:05.123Z');
    });

    it('**只抓本会话订阅的游戏**——别的游戏跟这条指令无关', async () => {
        let scraped: string[] = [];
        priceHandlerDeps.scrape = async (catalogs) => {
            scraped = catalogs.map((catalog) => catalog.name);

            return {};
        };

        await send(groupMessage('#currency game add 火炬之光', { role: 'admin' }));
        await send(groupMessage('#currency price'));

        expect(scraped).toEqual(['火炬之光']);
    });

    it('订阅的游戏已从 `catalogs` 里删掉时, 只提示没有可抓的, 不去抓别的', async () => {
        let scraped: string[] = [];
        priceHandlerDeps.scrape = async (catalogs) => {
            scraped = catalogs.map((catalog) => catalog.name);

            return {};
        };

        await send(groupMessage('#currency game add 流放之路2', { role: 'admin' }));
        pluginState.config = {
            ...pluginState.config,
            catalogs: pluginState.config.catalogs.filter((catalog) => catalog.name !== '流放之路2'),
        };

        await send(groupMessage('#currency price'));

        expect(scraped).toEqual([]);
    });

    it('**`price: null` 与 `price: 0` 的行在展示时都被过滤**, 并交代未取到的数量', async () => {
        await subscribeAndStub('流放之路2', {
            readAt: '2026-09-16T08:00:05.123Z',
            missing: [],
            zones: [
                {
                    zone: ['国服'],
                    readAt: '2026-09-16T08:00:05.123Z',
                    prices: [
                        { name: '神圣石', price: 0.2444, unit: '元/个' },
                        { name: '崇高石', price: null, unit: null },
                        { name: '卡兰德的魔镜', price: 0, unit: '元/个' },
                    ],
                },
            ],
        });

        const reply = await send(groupMessage('#currency price'));

        expect(reply).toContain('神圣石 0.2444 元/个');
        expect(reply).not.toContain('崇高石');
        expect(reply).not.toContain('卡兰德的魔镜');
        expect(reply).toContain('2 项未取到价格');
    });
});
