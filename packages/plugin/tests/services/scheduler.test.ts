/**
 * 调度器（片 08, §9.1 §9.4 §12.1）
 *
 * 停摆条件 / 重挂不累积 / 到点抓取落盘 / 配置运行中变更 / 跨整点重算。
 * 定时器用 vi.useFakeTimers 挂住, 不真等整点; 抓取经 deps 注入假件。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_CONFIG } from '../../src/config';
import { pluginState } from '../../src/core/state';
import { rearmScheduler, schedulerTick, SCHEDULER_TIMER_ID } from '../../src/services/scheduler';
import type { SchedulerDeps } from '../../src/services/scheduler';
import { SessionStore } from '../../src/store/session.store';
import { DataStore } from '../../src/store/data.store';
import { detectBrowserLightweight, invalidateBrowserStatus } from '../../src/services/browser/status';
import type { DetectOptions } from '../../src/services/browser/launcher';
import type { CatalogConfig } from '../../src/types';
import { createTestEnv, type TestEnv } from '../helpers/test-env';

let env: TestEnv;

const WITH_CHROME: DetectOptions = {
    platform: 'linux',
    env: {},
    homeDir: '/home/napcat',
    isFile: (path) => path === '/usr/bin/chromium',
};
const WITHOUT_CHROME: DetectOptions = { ...WITH_CHROME, isFile: () => false };

/** 固定"现在" = 本地 08:30, 避免测试结果随墙钟漂移 */
function fixedNow(): number {
    const now = new Date();
    now.setHours(8, 30, 0, 0);

    return now.getTime();
}

/** 本地日期 → 归档文件名 `YYYY-MM-DD.json` */
function archiveNameOf(ms: number): string {
    const date = new Date(ms);
    const pad = (value: number): string => String(value).padStart(2, '0');

    return (
        `archive/${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}.json`
    );
}

/** 计数假抓取器, 记录每轮被点名的游戏 */
function stubScrape(result: Record<string, unknown> = {}) {
    const calls: string[][] = [];

    const scrape = async (catalogs: CatalogConfig[]) => {
        calls.push(catalogs.map((catalog) => catalog.name));

        return result as never;
    };

    return { scrape, calls };
}

beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(fixedNow());
    env = createTestEnv();
    env.init();
    invalidateBrowserStatus();
    detectBrowserLightweight(WITH_CHROME);

    pluginState.config = {
        ...DEFAULT_CONFIG,
        enabled: true,
        pushHours: [9, 21],
        catalogs: ['流放之路2', '火炬之光'].map((name) => ({
            name,
            pageUrl: `https://qiandao.com/${name}`,
            currencyList: ['神圣石'],
            zoneConfigs: [['国服']],
        })),
    };
});

afterEach(() => {
    // 挂着的 setTimeout 不留到下一个用例（也不阻塞进程退出）
    for (const timer of pluginState.timers.values()) clearTimeout(timer);
    pluginState.timers.clear();
    vi.useRealTimers();
    env.dispose();
});

function subscribe(gameName: string): void {
    // test-env 默认群是 555, 会话键 `group:555`
    SessionStore.getInstance().addGame('group:555', gameName);
}

/** 一份成功结果; `readAt` 由调用方决定新旧 */
function okResult(readAt: string) {
    return {
        readAt,
        missing: [] as string[],
        zones: [
            {
                zone: ['国服'],
                readAt,
                prices: [{ name: '神圣石', price: 0.2444, unit: '元/个' }],
            },
        ],
    };
}

describe('rearmScheduler — 停摆条件（两个, 同一处处理）', () => {
    it('`pushHours` 为**空数组** → 不挂定时器（空数组是合法语义, 不是回退默认全选）', () => {
        pluginState.config = { ...pluginState.config, pushHours: [] };
        subscribe('流放之路2');

        rearmScheduler({ now: fixedNow });

        expect(pluginState.timers.has(SCHEDULER_TIMER_ID)).toBe(false);
    });

    it('**订阅并集为空** → 不挂定时器', () => {
        rearmScheduler({ now: fixedNow });

        expect(pluginState.timers.has(SCHEDULER_TIMER_ID)).toBe(false);
    });

    it('插件未启用（`enabled: false`）→ 不挂定时器', () => {
        pluginState.config = { ...pluginState.config, enabled: false };
        subscribe('流放之路2');

        rearmScheduler({ now: fixedNow });

        expect(pluginState.timers.has(SCHEDULER_TIMER_ID)).toBe(false);
    });

    it('**浏览器不可用 → 不挂调度器**（片 06 的规则在这里落地）', () => {
        detectBrowserLightweight(WITHOUT_CHROME);
        subscribe('流放之路2');

        rearmScheduler({ now: fixedNow });

        expect(pluginState.timers.has(SCHEDULER_TIMER_ID)).toBe(false);
    });
});

describe('rearmScheduler — 重挂', () => {
    it('运行中把 `pushHours` 改成空数组 → **取消现有定时器**, 不再触发', () => {
        subscribe('流放之路2');
        rearmScheduler({ now: fixedNow });
        expect(pluginState.timers.has(SCHEDULER_TIMER_ID)).toBe(true);

        pluginState.config = { ...pluginState.config, pushHours: [] };
        rearmScheduler({ now: fixedNow });

        expect(pluginState.timers.has(SCHEDULER_TIMER_ID)).toBe(false);
    });

    it('改 `pushHours` 后**无需重启**即按新集合触发', async () => {
        subscribe('流放之路2');
        const stub = stubScrape();

        pluginState.config = { ...pluginState.config, pushHours: [10] };
        const deps: SchedulerDeps = { now: () => Date.now(), scrape: stub.scrape };
        rearmScheduler(deps);

        // 08:30 → 10:00。中途（比如 9:00 这种**未选中**的小时）不该触发
        await vi.advanceTimersByTimeAsync(30 * 60 * 1000);
        expect(stub.calls).toHaveLength(0);

        // 到 10:00 触发; 抓取只点名**订阅并集里的**游戏
        await vi.advanceTimersByTimeAsync(90 * 60 * 1000);
        expect(stub.calls).toHaveLength(1);
        expect(stub.calls[0]).toEqual(['流放之路2']);
    });

    it('**热重载多次后定时器不累积**——每次重挂都先取消旧的', () => {
        subscribe('流放之路2');

        for (let i = 0; i < 5; i++) {
            rearmScheduler({ now: fixedNow });
        }

        expect(pluginState.timers.has(SCHEDULER_TIMER_ID)).toBe(true);
        expect(vi.getTimerCount()).toBe(1);
    });
});

describe('schedulerTick — 触发后的动作序列', () => {
    it('抓**过期的**游戏 → `data.json` 的 `readAt` 前进 → 归档多出 `trigger: "schedule"` 的 run', async () => {
        subscribe('流放之路2');

        // 预置一份 30 分钟前的旧数据 → 过期
        const oldReadAt = new Date(fixedNow() - 30 * 60_000).toISOString();
        DataStore.getInstance().saveGameResult('流放之路2', okResult(oldReadAt));

        const newReadAt = new Date(fixedNow()).toISOString();
        const stub = stubScrape({ 流放之路2: okResult(newReadAt) });

        await schedulerTick({ now: fixedNow, scrape: stub.scrape });

        expect(stub.calls).toEqual([['流放之路2']]);

        const data = JSON.parse(env.readDataFile('data.json') ?? '{}');
        expect(data.games['流放之路2'].readAt).toBe(newReadAt);

        const archive = JSON.parse(env.readDataFile(archiveNameOf(fixedNow())) ?? '{}');
        expect(archive.runs).toHaveLength(1);
        expect(archive.runs[0].trigger).toBe('schedule');
        expect(archive.runs[0].startedAt).toBeTruthy();
        expect(archive.runs[0].finishedAt).toBeTruthy();
        expect(archive.runs[0].games['流放之路2'].readAt).toBe(newReadAt);
    });

    it('**全部游戏都新鲜时不抓取**——订阅并集里的游戏逐个判新鲜度', async () => {
        subscribe('流放之路2');

        // 1 分钟前抓过 → 新鲜
        DataStore.getInstance().saveGameResult(
            '流放之路2',
            okResult(new Date(fixedNow() - 60_000).toISOString()),
        );

        const stub = stubScrape();
        await schedulerTick({ now: fixedNow, scrape: stub.scrape });

        expect(stub.calls).toHaveLength(0);
    });

    it('**抓取跨过整点时, 下一次触发基于完成时刻重算**——不产生自我重叠', async () => {
        subscribe('流放之路2');

        // 08:30 挂上定时器 → 9:00
        rearmScheduler({ now: fixedNow });

        // 抓取期间时间冲到 9:05（跨过了触发点 9:00）
        const newReadAt = new Date(fixedNow() + 35 * 60_000).toISOString();
        const stub = stubScrape({ 流放之路2: okResult(newReadAt) });
        const realScrape = stub.scrape;
        stub.scrape = (async (catalogs: CatalogConfig[]) => {
            vi.setSystemTime(fixedNow() + 35 * 60_000);

            return realScrape(catalogs);
        }) as typeof stub.scrape;

        await schedulerTick({ now: () => Date.now(), scrape: stub.scrape });

        // 完成时刻 9:05 → 下一个选中整点是 21:00, **不是** 9:00 的立即再触发
        expect(vi.getTimerCount()).toBe(1);
        expect(stub.calls).toHaveLength(1);

        // 从 9:05 推进到 21:00 之前不该再触发
        await vi.advanceTimersByTimeAsync(11 * 60 * 60 * 1000);
        expect(stub.calls).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
        expect(stub.calls).toHaveLength(2);
    });

    it('运行中 `pushHours` 被清空 → 触发后**不再重挂**（停摆检查在触发后再做一次）', async () => {
        subscribe('流放之路2');
        rearmScheduler({ now: fixedNow });
        expect(pluginState.timers.has(SCHEDULER_TIMER_ID)).toBe(true);

        // 抓取期间配置被清空
        const stub = stubScrape();
        stub.scrape = (async () => {
            pluginState.config = { ...pluginState.config, pushHours: [] };

            return {} as never;
        }) as typeof stub.scrape;

        await schedulerTick({ now: fixedNow, scrape: stub.scrape });

        expect(pluginState.timers.has(SCHEDULER_TIMER_ID)).toBe(false);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('触发时**恰好整点不退化成立即再触发**——重挂基于完成时刻严格大于', async () => {
        subscribe('流放之路2');

        // 30 分钟前的旧数据 → 触发时判过期, 会真的抓一把
        DataStore.getInstance().saveGameResult(
            '流放之路2',
            okResult(new Date(fixedNow() - 30 * 60_000).toISOString()),
        );

        // 抓取耗时 5 秒: 9:00:00 开始, 9:00:05 结束
        const stub = stubScrape();
        const realScrape = stub.scrape;
        stub.scrape = (async (catalogs: CatalogConfig[]) => {
            vi.setSystemTime(fixedNow() + 30 * 60 * 1000 + 5000);

            return realScrape(catalogs);
        }) as typeof stub.scrape;

        // 直接把定时器拨到 9:00 整开火（deps 要带上假抓取器, 闭包会把它带进 tick）
        rearmScheduler({ now: fixedNow, scrape: stub.scrape });
        await vi.advanceTimersByTimeAsync(30 * 60 * 1000);

        expect(stub.calls).toHaveLength(1);
        // 下一轮要等 21:00（约 12 小时后）, 而不是 setTimeout(0)
        await vi.advanceTimersByTimeAsync(60 * 1000);
        expect(stub.calls).toHaveLength(1);
    });
});
