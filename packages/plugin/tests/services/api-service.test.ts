/**
 * WebUI API 端点
 *
 * ⚠️ 本片的**头号验收项**在 `/chrome/status`: 模板的 WebUI 每 5 秒轮询一次状态,
 * 如果状态查询每次都跑 `launch()`, 只要有人开着面板就会每 5 秒拉起一次浏览器。
 * **检测与查询必须分离**。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../../src/config';
import { pluginState } from '../../src/core/state';
import { handleMessage } from '../../src/handlers/message-handler';
import { priceHandlerDeps } from '../../src/handlers/currency/price.handler';
import { registerApiRoutes, apiServiceDeps } from '../../src/services/api-service';
import { schedulerTick, stopScheduler } from '../../src/services/scheduler';
import {
    detectBrowserLightweight,
    detectBrowserFull,
    invalidateBrowserStatus,
} from '../../src/services/browser/status';
import { installerDeps, resetInstallState } from '../../src/services/browser/chrome-installer';
import type { DetectOptions } from '../../src/services/browser/launcher';
import { SessionStore } from '../../src/store/session.store';
import {
    createTestEnv,
    groupMessage,
    readStateFile,
    seedGameResult,
    type TestEnv,
} from '../helpers/test-env';

let env: TestEnv;

const CHROMIUM = '/usr/bin/chromium';

const WITH_CHROME: DetectOptions = {
    platform: 'linux',
    env: {},
    homeDir: '/home/napcat',
    isFile: (path) => path === CHROMIUM,
};

const WITHOUT_CHROME: DetectOptions = { ...WITH_CHROME, isFile: () => false };

/** 假浏览器。`version()` 是判定"真的 launch 过"的唯一途径 */
function fakeBrowser(version = '141.0.7390.54') {
    return { version: () => version, close: async (): Promise<void> => {} };
}

beforeEach(() => {
    env = createTestEnv();
    env.init();
    invalidateBrowserStatus();
    resetInstallState();
    pluginState.config = { ...DEFAULT_CONFIG };
    registerApiRoutes(env.ctx);
});

afterEach(() => {
    env.dispose();
});

describe('/chrome/status — 只读缓存（本片头号验收项）', () => {
    it('**连续轮询多次, `launch()` 次数不变**——开着面板不该每 5 秒拉起一次浏览器', async () => {
        let launched = 0;
        await detectBrowserFull({
            ...WITH_CHROME,
            launch: async () => {
                launched++;

                return fakeBrowser();
            },
        });
        expect(launched).toBe(1);

        for (let i = 0; i < 10; i++) await env.callRoute('GET /chrome/status');

        expect(launched).toBe(1);
    });

    it('轮询同样**不做文件检测**——缓存有了就只读缓存', async () => {
        let fileChecks = 0;
        detectBrowserLightweight({
            ...WITH_CHROME,
            isFile: (path) => {
                fileChecks++;

                return path === CHROMIUM;
            },
        });

        const afterDetect = fileChecks;
        for (let i = 0; i < 5; i++) await env.callRoute('GET /chrome/status');

        expect(fileChecks).toBe(afterDetect);
    });

    it('返回可用性、路径与版本', async () => {
        await detectBrowserFull({ ...WITH_CHROME, launch: async () => fakeBrowser('141.0.7390.54') });

        const { body } = await env.callRoute('GET /chrome/status');

        expect(body).toMatchObject({
            code: 0,
            data: { available: true, path: CHROMIUM, version: '141.0.7390.54' },
        });
    });

    it('浏览器不可用时如实返回, 并带上原因', async () => {
        detectBrowserLightweight(WITHOUT_CHROME);

        const { body } = await env.callRoute('GET /chrome/status');

        expect(body).toMatchObject({ code: 0, data: { available: false } });
        expect((body as { data: { error: string } }).data.error).toBeTruthy();
    });
});

describe('/chrome/detect — 执行检测并刷新缓存', () => {
    const realDetect = apiServiceDeps.detectBrowserFull;

    afterEach(() => {
        apiServiceDeps.detectBrowserFull = realDetect;
    });

    it('执行检测并返回路径与版本', async () => {
        apiServiceDeps.detectBrowserFull = () => detectBrowserFull({
            ...WITH_CHROME,
            launch: async () => fakeBrowser('141.0.7390.54'),
        });

        const { body } = await env.callRoute('POST /chrome/detect');

        expect(body).toMatchObject({
            code: 0,
            data: { available: true, path: CHROMIUM, version: '141.0.7390.54' },
        });
    });

    it('检测结果进缓存——之后 `/chrome/status` 能读到', async () => {
        apiServiceDeps.detectBrowserFull = () => detectBrowserFull({
            ...WITH_CHROME,
            launch: async () => fakeBrowser('141.0.7390.54'),
        });

        await env.callRoute('POST /chrome/detect');
        const { body } = await env.callRoute('GET /chrome/status');

        expect(body).toMatchObject({ data: { available: true, version: '141.0.7390.54' } });
    });
});

describe('/chrome/install 与进度', () => {
    const realInstall = installerDeps.install;

    afterEach(() => {
        installerDeps.install = realInstall;
    });

    it('没装过时进度是「未在安装」, 不是空响应', async () => {
        const { body } = await env.callRoute('GET /chrome/install/progress');

        expect(body).toMatchObject({ code: 0, data: { running: false, error: null } });
    });

    it('**触发安装**后能读到进度`, 且进度带当前源名', async () => {
        let release: () => void = () => {};
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });

        installerDeps.install = async (deps) => {
            deps?.onProgress?.({
                phase: 'downloading',
                percent: 0.4,
                source: 'npmmirror CDN',
                message: '正在下载…',
            });
            await gate;

            return { path: CHROMIUM, source: 'npmmirror CDN', version: '141' };
        };

        await env.callRoute('POST /chrome/install');

        const { body } = await env.callRoute('GET /chrome/install/progress');
        expect(body).toMatchObject({
            data: { running: true, progress: { percent: 0.4, source: 'npmmirror CDN' } },
        });

        release();
    });

    it('安装失败时进度里留下**可读的失败原因**（多源逐个回退后的总结）', async () => {
        installerDeps.install = async () => {
            throw new Error('Chrome 安装失败，所有下载源都不可用：\n- Google：连接超时');
        };

        await env.callRoute('POST /chrome/install');
        // 安装是后台跑的, 让出一次事件循环等它落定
        await new Promise((resolve) => setTimeout(resolve, 0));

        const { body } = await env.callRoute('GET /chrome/install/progress');
        expect((body as { data: { error: string; running: boolean } }).data.error).toContain(
            '所有下载源都不可用',
        );
        expect((body as { data: { running: boolean } }).data.running).toBe(false);
    });
});

describe('/status — 各游戏最后抓取时间', () => {
    it('带上每个游戏自己的 `readAt`——仪表盘要显示"这个游戏的数据是什么时候的"', async () => {
        seedGameResult('流放之路2', {
            readAt: '2026-09-16T08:00:05.123Z',
            missing: [],
            zones: [],
        });

        const { body } = await env.callRoute('GET /status');

        expect(body).toMatchObject({
            data: { games: [{ name: '流放之路2', readAt: '2026-09-16T08:00:05.123Z' }] },
        });
    });
});

describe('/catalogs — 分区配置的读写', () => {
    it('`pageUrl` 原样回显: 六个 query 参数一个不丢、不做结构拆分', async () => {
        pluginState.config.catalogs = [
            {
                name: '流放之路2',
                pageUrl: FULL_PAGE_URL,
                zoneConfigs: [['国服', '赛季', '普通']],
                currencyList: ['神圣石'],
            },
        ];

        const { body } = await env.callRoute('GET /catalogs');

        expect(body).toMatchObject({
            code: 0,
            data: [
                {
                    name: '流放之路2',
                    pageUrl: FULL_PAGE_URL,
                    zoneConfigs: [['国服', '赛季', '普通']],
                    currencyList: ['神圣石'],
                },
            ],
        });
    });
});

describe('POST /catalogs — 保存后下一轮就按新配置走', () => {
    it('保存的清单**直接写进内存配置**——不用重启, `price` 与调度器下次读到的就是它', async () => {
        const next = [
            {
                name: '火炬之光',
                pageUrl: FULL_PAGE_URL,
                zoneConfigs: [['赛季', '普通'], ['赛季', '专家']],
                currencyList: ['初火源质'],
            },
        ];

        const { body } = await env.callRoute('POST /catalogs', { body: { catalogs: next } });

        expect(body).toMatchObject({ code: 0 });
        // 内存配置是**唯一真源**: `price` / 调度器每轮都从这里现读, 不缓存副本
        expect(pluginState.config.catalogs).toEqual(next);

        const echo = await env.callRoute('GET /catalogs');
        expect(echo.body).toMatchObject({ data: next });
    });
});

describe('POST /catalogs — 清洗在保存路径上同样生效', () => {
    it('非法条目丢弃、合法条目保留; 字段级问题只降级该字段, 不牵连整条', async () => {
        const good = {
            name: '合法甲',
            pageUrl: 'https://example.com/a',
            zoneConfigs: [['国服', '赛季']],
            currencyList: ['神圣石'],
        };
        const goodWithJunkFields = {
            name: '合法乙',
            pageUrl: 'https://example.com/d',
            zoneConfigs: [['赛季', '普通'], '不是数组', ['赛季', 123]],
            currencyList: '不是数组',
        };

        await env.callRoute('POST /catalogs', {
            body: {
                catalogs: [
                    good,
                    null,
                    { pageUrl: 'https://example.com/b' }, // 缺 name
                    { name: '缺URL' }, // 缺 pageUrl
                    { name: '   ', pageUrl: 'https://example.com/c' }, // 空白 name 等同缺失
                    goodWithJunkFields,
                ],
            },
        });

        expect(pluginState.config.catalogs).toEqual([
            good,
            {
                name: '合法乙',
                pageUrl: 'https://example.com/d',
                // 只有整行都是非空字符串的组合才留得下来: 少一级的组合会**静默指向另一个区服**
                zoneConfigs: [['赛季', '普通']],
                currencyList: [],
            },
        ]);
    });
});

describe('GET /sessions — 群管理页读的是真实订阅关系, 不是死 UI', () => {
    it('回显各会话的通知开关与已订阅游戏, 且与 `state.json` 落盘内容一致', async () => {
        // 模拟群里的 `notify on` 与 `game add` —— 页面要反映的就是这些改动
        const store = SessionStore.getInstance();
        store.setNotifyEnabled('group:555', true);
        store.addGame('group:555', '流放之路2');
        store.setNotifyEnabled('private:10002', true);

        const { body } = await env.callRoute('GET /sessions');

        const sessions = {
            'group:555': { notifyEnabled: true, enabledGames: ['流放之路2'] },
            // 只开了通知、还没订游戏 —— 这也是一条真实状态, 不该被省略
            'private:10002': { notifyEnabled: true, enabledGames: [] },
        };

        expect(body).toMatchObject({ code: 0, data: sessions });
        // 与磁盘一致: 页面看到的不是一份会飘的内存副本
        expect(readStateFile(env)).toMatchObject({ sessions });
    });
});

describe('改完分区配置, 下一次抓取就按新配置执行（无需重启）', () => {
    const realScrape = priceHandlerDeps.scrape;

    afterEach(() => {
        priceHandlerDeps.scrape = realScrape;
    });

    it('POST /catalogs 改 `pageUrl` 后, `#currency price` 抓到的是**新** URL', async () => {
        // 不重新 init pluginState —— 这一条要证明的正是"不用重启"
        detectBrowserLightweight(WITH_CHROME);
        SessionStore.getInstance().addGame('group:555', '流放之路2');

        let scrapedUrls: string[] = [];
        priceHandlerDeps.scrape = async (catalogs) => {
            scrapedUrls = catalogs.map((catalog) => catalog.pageUrl);

            return {};
        };

        await env.callRoute('POST /catalogs', {
            body: {
                catalogs: [
                    {
                        name: '流放之路2',
                        pageUrl: FULL_PAGE_URL,
                        zoneConfigs: [['国服', '赛季', '普通']],
                        currencyList: ['神圣石'],
                    },
                ],
            },
        });

        await handleMessage(env.ctx, groupMessage('#currency price'));

        expect(scrapedUrls).toEqual([FULL_PAGE_URL]);
    });
});

describe('新增的游戏, 指令与调度器立刻就能看到', () => {
    afterEach(() => {
        // `schedulerTick` 的 finally 会重挂定时器, 不清理会给后续用例留一条指向下个整点的 setTimeout
        stopScheduler();
    });

    it('`POST /catalogs` 加一个游戏后, `#currency game` 列出它', async () => {
        await env.callRoute('POST /catalogs', {
            body: {
                catalogs: [
                    {
                        name: '原神',
                        pageUrl: 'https://example.com/genshin',
                        zoneConfigs: [['国服']],
                        currencyList: ['原石'],
                    },
                ],
            },
        });

        await handleMessage(env.ctx, groupMessage('#currency game'));

        expect(env.sent.at(-1)).toContain('原神');
    });

    it('调度器下一轮抓的是新加的游戏', async () => {
        detectBrowserLightweight(WITH_CHROME);
        SessionStore.getInstance().addGame('group:555', '原神');

        await env.callRoute('POST /catalogs', {
            body: {
                catalogs: [
                    {
                        name: '原神',
                        pageUrl: 'https://example.com/genshin',
                        zoneConfigs: [['国服']],
                        currencyList: ['原石'],
                    },
                ],
            },
        });

        let scraped: string[] = [];
        await schedulerTick({
            scrape: async (catalogs) => {
                scraped = catalogs.map((catalog) => catalog.name);

                return {};
            },
        });

        expect(scraped).toEqual(['原神']);
    });
});

/**
 * 一条**含全部六个 query 参数**的真实形态 URL。
 *
 * 刻意在测试里写成字面量而不复用 `config.ts` 的 `CATALOGS`: 期望值必须来自独立真值,
 * 复用被测实现读的那份常量等于同义反复。`tagIds` 里的方括号与逗号也是要防的一类改写——
 * 它一旦被 URL 编码成 `%5B`, 站点就认不出来了。
 */
const FULL_PAGE_URL =
    'https://qiandao.com/currency/currency-zone?catalogName=%E6%B5%81%E6%94%BE2%E4%B8%93%E5%8C%BA&islandId=301000&tagIds=[1707645,1708106]&attributeId=904221228984762040&entryId=1707645&entryType=TAG';
