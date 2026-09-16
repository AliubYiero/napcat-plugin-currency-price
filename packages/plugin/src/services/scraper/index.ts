/**
 * 抓取主流程
 *
 * 改造自抓取源项目的一次性脚本, 但**编排与页面交互分了家**:
 *
 * - `CatalogPage` 是**页面交互边界**。它封装"打开页面、切区服、等渲染、读列表"这些
 *   只能在真机上验的动作, 也是三条硬约束里「页面级加载校验」的落点。
 * - 本模块是**编排层**。它回答"这轮拿到什么数据、哪些算数"——游戏级原子性、`missing`
 *   交集、失败不留半截。这些是决策, 不该和浏览器时序绑在一起才能测。
 *
 * 设计文档 §8.1 的三条接口约定在这里兑现:
 * - 返回值与 `data.json` 的 `games` **完全同构**, 调用方零转换
 * - `error` 字段的**有无即成败判定**（`GameFail` 由 `scrapeGames` 产出）
 * - 本层**不做落盘、不做推送、不做归档**, 也不知道谁订阅了、为什么被调用
 */

import type { GameOk, ZoneRecord } from '../../store/data.store';
import type { CatalogConfig } from '../../types';
import { buildUserAgent, launchBrowser } from '../browser/launcher';
import { createCatalogPage } from './page';
import { parseCurrencyRow, type RawCurrencyRow } from './parse';

/** 价格接口给出的期望价格: 通货名 → 价格。用于等待渲染完成, 并与 DOM 读到的值交叉比对 */
export type ZoneExpectation = Map<string, number>;

/**
 * 一个游戏页面的交互边界。
 *
 * 实现方负责所有真实页面动作与它们各自的确认步骤——**任何一步不确定都必须抛错**,
 * 不能返回一个"看起来还行"的结果: 编排层无从分辨"页面没渲染"与"这个通货没有报价"。
 */
export interface CatalogPage {
    /**
     * 打开页面并确认**关键元素已经出现**。
     *
     * ⚠️ 站点按 UA 拦截时页面是个空壳（连 DOM 都渲染不出来）, 此处必须显式抛错——
     * 不校验就会静默写出满篇空值（设计文档 §8.3 硬约束 3）。
     */
    open(pageUrl: string): Promise<void>;

    /**
     * 读取「区服路径 → 区服标识」映射。
     *
     * ⚠️ **按游戏各自返回**, 换游戏后必须重新读, 不能沿用上一个游戏的映射。
     */
    readZoneSpecIds(): Promise<Map<string, string>>;

    /**
     * 切到目标区服并**回读选择器确认切换真的生效**；返回本次接口给出的期望价格。
     *
     * 点击被吞掉时（选项未渲染完、面板状态残留）必须抛错: 否则下面读到的是上一个区服的
     * 旧值, 而且它看起来完全正常。
     */
    selectZone(zonePath: string[]): Promise<ZoneExpectation>;

    /** 读左侧列表里每一行的原始文本（解析在编排层做） */
    readCurrencyRows(): Promise<RawCurrencyRow[]>;

    /**
     * 等列表渲染出接口返回的数据, 并**顺带与 DOM 交叉比对**。
     *
     * 响应到达 ≠ DOM 已更新: 实测切换区服时列表会**先清空再重绘**, 响应刚回来时读到的
     * 可能是空列表。返回 `false` 表示两条来源对不上——编排层据此抛错。
     */
    waitForListRendered(expected: ZoneExpectation, currencyList: string[]): Promise<boolean>;
}

/** 编排层的注入点。生产代码用缺省值, 测试注入固定时刻以便断言 */
export interface ScrapeDeps {
    /** 取当前时刻 (ISO 8601 UTC) */
    now?: () => string;
}

/** 一次抓取过程的页面会话。抓完必须 `close()` */
export interface PageSession {
    page: CatalogPage;
    close(): Promise<void>;
}

/** `scrapeGames` 的注入点 */
export interface ScrapeGamesDeps {
    /** 开一个页面会话。缺省实现起真实浏览器; 测试注入假件 */
    openPage?: (executablePath: string) => Promise<PageSession>;
    /** 浏览器可执行文件路径（由调用方先经 `detectChrome` 得到） */
    executablePath?: string;
    /** 取当前时刻 (ISO 8601 UTC) */
    now?: () => string;
}

/**
 * 抓取多个游戏。
 *
 * 这是抓取层对外的**唯一入口**, 返回值与 `data.json` 的 `games`、归档的 `runs[].games`
 * **完全同构**（§8.1）, 调用方零转换:
 * - 成功 → `GameOk`（`readAt` / `zones` / `missing`）
 * - 失败 → `GameFail`（只有 `error`）
 *
 * ⚠️ 本层**不做落盘、不做推送、不做归档**, 也不知道谁订阅了、为什么被调用——
 * 它只回答"这几个游戏现在值多少"。`startedAt` / `finishedAt` / `trigger` 由调度层记。
 *
 * ⚠️ 多个游戏**共用同一个 page 串行**跑（§9.3 不做游戏级并发）: UA 挂在 context 上、
 * 页面状态在组合间累积, 并发就得开多个 browser/page, 而"两个会话同一分钟都发 price"
 * 是低频事件, 排队等一两分钟是可接受的代价。
 *
 * 单个游戏的失败被隔离在它自己身上, 不影响其他游戏——但**失败的游戏不会留下任何条目**
 * （`scrapeCatalog` 的游戏级原子性保证了这一点）。
 */
export async function scrapeGames(
    catalogs: CatalogConfig[],
    deps: ScrapeGamesDeps = {},
): Promise<Record<string, GameOk | GameFail>> {
    const result: Record<string, GameOk | GameFail> = {};

    // 没有要抓的游戏就别去开一个浏览器进程
    if (catalogs.length === 0) return result;

    const openPage = deps.openPage ?? defaultOpenPage;
    const session = await openPage(deps.executablePath ?? '');

    try {
        for (const catalog of catalogs) {
            try {
                result[catalog.name] = await scrapeCatalog(session.page, catalog, { now: deps.now });
            } catch (error) {
                // 用一条只有 `error` 的结果留痕: 消费方据此能区分"这个游戏抓失败了"与
                // "这次本来就没配这个游戏", 而不是靠数量去猜（§8.1）
                result[catalog.name] = { error: messageOf(error) };
            }
        }
    } finally {
        // 抓完一定关掉: 浏览器是重资源, 失败路径上漏关会一路积到宿主内存里
        await closeQuietly(session);
    }

    return result;
}

/**
 * 缺省页面会话: 起一个真实浏览器, 建 context 与 page。
 *
 * ⚠️ **UA 伪装必须挂在 `context` 上**（设计文档 §15）。UA 无法在 `launch()` 设置, 所以
 * 不能用 `browser.newPage()`——必须显式建 context。站点按 UA 拦截: UA 里含
 * "HeadlessChrome" 时文档请求直接 405, 页面连 DOM 都渲染不出来。
 */
async function defaultOpenPage(executablePath: string): Promise<PageSession> {
    const browser = await launchBrowser(executablePath);

    const context = await browser.newContext({
        userAgent: buildUserAgent(browser.version()),
        locale: 'zh-CN',
        viewport: { width: 1600, height: 900 },
    });

    return {
        page: createCatalogPage(await context.newPage()),
        close: async (): Promise<void> => {
            await browser.close();
        },
    };
}

function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/** 关闭会话。关不掉只该记日志, 不该让整轮抓取的结果作废 */
async function closeQuietly(session: PageSession): Promise<void> {
    try {
        await session.close();
    } catch {
        /* 忽略: 浏览器进程即使没关干净, 宿主退出时也会回收 */
    }
}

/**
 * 抓取**一个游戏**的全部区服组合。
 *
 * ⚠️ **游戏级原子性**: 任一区服组合失败都直接抛出, 本地 `zones` 只在全部组合成功后才
 * 返回。失败的游戏因此**不会留下半截数据**——已成功读到的组合一并作废（§7.2 规则 1）。
 * 这是源项目三条硬约束中的「失败不留半截数据」, 不得为了"多保留一点数据"改成部分成功。
 *
 * @throws 页面加载校验失败 / 区服切换未生效 / DOM 与接口对不上 / 配置里的组合页面上没有
 */
export async function scrapeCatalog(
    page: CatalogPage,
    catalog: CatalogConfig,
    deps: ScrapeDeps = {},
): Promise<GameOk> {
    const now = deps.now ?? ((): string => new Date().toISOString());

    await page.open(catalog.pageUrl);

    // 区服标识来自级联接口: 拿不到就无法判断价格属于哪个区服, 继续跑只会产出无法校验的结果
    const zoneSpecIds = await page.readZoneSpecIds();
    assertZonesConfigured(catalog, zoneSpecIds);

    const zones: ZoneRecord[] = [];
    /** 每个组合各自"名称没找到"的通货。游戏级 `missing` 由此取交集 */
    const missingPerZone: string[][] = [];

    for (const zonePath of catalog.zoneConfigs) {
        const expected = await page.selectZone(zonePath);

        // 响应到达 ≠ DOM 已更新。两条来源对不上时抛错, 而不是把可能是旧值的数据读走
        const rendered = await page.waitForListRendered(expected, catalog.currencyList);
        if (!rendered) {
            throw new Error(
                `${catalog.name} 的「${zonePath.join(' / ')}」列表未渲染出接口返回的数据, ` +
                    'DOM 与价格接口不一致, 已中止以避免取到旧值',
            );
        }

        const rows = await page.readCurrencyRows();

        zones.push({
            zone: zonePath,
            // 读取时刻的粒度是**区服组合**, 不是游戏, 也不是整次抓取（见 CONTEXT.md）
            readAt: now(),
            prices: buildPrices(catalog.currencyList, rows),
        });

        // ⚠️ `missing` 必须在这里算, 不能事后从 `prices` 反推: 落到 `prices` 上之后,
        // "名称未匹配"与"页面显示 `--`"都是 `price: null`, 再也分不开（§21 已知问题）。
        missingPerZone.push(
            catalog.currencyList.filter((name) => !rows.some((item) => item.name === name)),
        );
    }

    return {
        readAt: zones.reduce((latest, zone) => (zone.readAt > latest ? zone.readAt : latest), ''),
        zones,
        missing: intersect(catalog.currencyList, missingPerZone),
    };
}

/**
 * 提前校验配置: 组合写错时立刻给出可用清单, 而不是卡到点击超时。
 *
 * 这是配置写错时**唯一能在抓取阶段被发现**的形态——`zoneConfigs` 里的组合在页面上不存在。
 */
function assertZonesConfigured(catalog: CatalogConfig, zoneSpecIds: Map<string, string>): void {
    const unknown = catalog.zoneConfigs.filter((zone) => !zoneSpecIds.has(zone.join('/')));
    if (unknown.length === 0) return;

    throw new Error(
        `${catalog.name} 的 zoneConfigs 中存在页面上没有的组合：` +
            `${unknown.map((zone) => zone.join('/')).join('、')}\n` +
            `页面可选组合：${[...zoneSpecIds.keys()].join('、')}`,
    );
}

/**
 * 按配置的通货清单整理价格。
 *
 * **不在列表里的通货记 `null`, 绝不写 0 占位**（§8.3 硬约束 1）——`0` 表示"页面确实报 0"，
 * `null` 表示"本次未取到", 两者语义相反。本项目特意把这个歧义修掉了, 不要退回去。
 */
function buildPrices(currencyList: string[], rows: RawCurrencyRow[]) {
    return currencyList.map((name) => {
        const hit = rows.find((item) => item.name === name);

        return hit ? parseCurrencyRow(hit) : { name, price: null, unit: null };
    });
}

/**
 * 游戏级 `missing` = 各组合"名称没找到"的**交集**（§7.2）。
 *
 * ⚠️ **是交集不是并集**: 不同区服提供的通货本来就不同（某通货可能只在国服有）, 所以
 * "某个组合缺某通货"是正常业务差异。真正指向配置写错（通货名拼错）的信号是
 * "**所有组合都缺同一个名字**"——这是该类错误唯一能让用户发现的途径, 因为被过滤掉的
 * 行在消息里看不见。
 *
 * ⚠️ 按**配置清单**的顺序输出, 而不是按发现顺序: 消息里的呈现顺序应当是配置说了算。
 */
function intersect(currencyList: string[], missingPerZone: string[][]): string[] {
    return currencyList.filter((name) => missingPerZone.every((missing) => missing.includes(name)));
}
