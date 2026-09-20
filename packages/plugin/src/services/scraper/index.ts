/**
 * 抓取主流程
 *
 * 改造自抓取源项目的一次性脚本, 但**编排与页面交互分了家**:
 *
 * - `CatalogPage` 是**页面交互边界**。它封装"打开页面、切区服、读列表、点开详情"这些
 *   只能在真机上验的动作, 也是三条硬约束里「页面级加载校验」的落点。
 * - 本模块是**编排层**。它回答"这轮拿到什么数据、哪些算数"——接口优先取值、游戏级原子性、
 *   `missing` 交集、市价失真、失败不留半截。这些是决策, 不该和浏览器时序绑在一起才能测。
 *
 * 设计文档 §8.1 的三条接口约定在这里兑现:
 * - 返回值与 `data.json` 的 `games` **完全同构**, 调用方零转换
 * - `error` 字段的**有无即成败判定**（`GameFail` 由 `scrapeGames` 产出）
 * - 本层**不做落盘、不做推送、不做归档**, 也不知道谁订阅了、为什么被调用
 *
 * ⚠️ 价格**取自接口响应**（见 ADR-0006）, DOM 只在接口没给这个通货时兜底。因此 `price` /
 * `unit` 的方向是**比率方向（`个/元`）**, 与 `rmbPrice` / `rmbUnit` 是两个独立的事实。
 */

import type { CurrencyConfig } from '../../types';
import type { GameOk, ZoneRecord } from '../../store/data.store';
import type { CatalogConfig } from '../../types';
import { buildUserAgent, launchBrowser } from '../browser/launcher';
import {
    clearActiveBrowser,
    setActiveBrowser,
} from '../browser/active';
import { pluginState } from '../../core/state';
import { createCatalogPage } from './page';
import {
    parseCurrencyRow,
    type PriceItem,
    type RawCurrencyRow,
} from './parse';
import { attachDetail, type CurrencyDetail } from './detail';

/**
 * 价格接口给出的一条期望价格。
 *
 * ⚠️ **两个方向都是接口字段, 不做任何换算**（ADR-0005 结论 2）。`rmbPrice` 缺失时记
 * `null`——"读不出元价"与"元价是 0"是两件事。
 */
export interface ExpectedPrice {
    /** 比率价 = 1 元能买几个（接口 `ratioPrice`）。**主方向** */
    ratioPrice: number;
    /** 计的通货单位, 如 `个` / `万金`。拼 `个/元` 与 `元/个` 都用它 */
    ratioUnit: string | null;
    /** 元价（接口 `rmbPrice`，只到 4 位小数）。接口没给时为 `null` */
    rmbPrice: number | null;
}

/** 价格接口给出的期望价格: 通货名 → 两个方向。用于**等待 DOM 刷新**与取值 */
export type ZoneExpectation = Map<string, ExpectedPrice>;

/**
 * 一次详情采集的结果。
 *
 * `thin` 与 `detail` **互不依赖**: 数不出条数不代表没取到挂单（DOM 兜底照样有挂单）,
 * 取到挂单也不代表条数够（挂单列表为空时 `thin` 就是 `true`）。
 */
export interface DetailFetch {
    /** 详情块; 成交量与挂单都取不到时为 `null` */
    detail: CurrencyDetail | null;
    /** 响应里的挂单条数是否少到市价不可信; `null` = 响应没到, 数不出条数, 不判定 */
    thin: boolean | null;
    /** 数出的挂单条数; `null` = 数不出。仅用于日志 */
    count: number | null;
    /** 接口给的 `total`; `null` = 接口没给这个字段（此时条数是按 `items` 数的）。仅用于日志 */
    total: number | null;
}

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
     * 切到目标区服, 断言切换生效, 并返回本次接口给出的期望价格。
     *
     * 区服归属由**请求体的 `specIds`** 唯一确定; 选择器回读只是让失败报得更清楚。
     */
    selectZone(zonePath: string[]): Promise<ZoneExpectation>;

    /** 读左侧列表里每一行的原始文本（解析在编排层做） */
    readCurrencyRows(): Promise<RawCurrencyRow[]>;

    /**
     * 等 DOM 刷新出接口返回的数据。**只在需要走 DOM 兜底时才调用**。
     *
     * ⚠️ 它不再是价格正确性的防线（价格由接口定）, 唯一职责是"DOM 刷新了没有"。
     * 返回 `false` 表示没等到——调用方**不该据此作废整个游戏**, 只该把那些需要兜底的
     * 通货记 `null`。
     */
    waitForListRendered(
        expected: ZoneExpectation,
        currencyNames: string[],
    ): Promise<boolean>;

    /**
     * 点开目标通货的详情面板, 读出成交量与挂单, 并判挂单深度。
     *
     * ⚠️ 详情**失败不抛错**（除面板回读失败外）: 它不产生错值, "没去取"与"取不到"在数据里
     * 可区分。让一个冷门通货的详情超时把整份价格赔进去, 收益为零。
     */
    readCurrencyDetail(
        currencyName: string,
        specId: string,
        topN: number,
    ): Promise<DetailFetch>;
}

/** 编排层的注入点。生产代码用缺省值, 测试注入固定时刻以便断言 */
export interface ScrapeDeps {
    /** 取当前时刻 (ISO 8601 UTC) */
    now?: () => string;
    /** 记一条**抓取细节**（详情耗时、挂单深度判定）。缺省写插件日志器的 debug */
    log?: (message: string) => void;
    /**
     * 记一条**需要被看见**的日志。缺省写插件日志器的 warn。
     *
     * ⚠️ 与 `log` 分开是有意义的: 走 debug 的东西是"事后排查用", 而这里的两类是
     * **阈值/配置出问题的唯一信号**——全缺的接口响应（更像接口改版而不是名字拼错）
     * 与失真的条数判定（阈值只来自源项目实测, 插件侧三个游戏未各自验证）。
     * 混进 debug 里等于没有。
     */
    warn?: (message: string) => void;
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
    /** 记一条抓取细节。见 `ScrapeDeps.log` */
    log?: (message: string) => void;
    /** 记一条需要被看见的日志。见 `ScrapeDeps.warn` */
    warn?: (message: string) => void;
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
                result[catalog.name] = await scrapeCatalog(
                    session.page,
                    catalog,
                    {
                        now: deps.now,
                        log: deps.log,
                        warn: deps.warn,
                    },
                );
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
async function defaultOpenPage(
    executablePath: string,
): Promise<PageSession> {
    const browser = await launchBrowser(executablePath);

    // 登记到全局: 插件卸载（plugin_cleanup）时要**强制关闭**进行中的抓取, 不等待
    setActiveBrowser(browser);

    const context = await browser.newContext({
        userAgent: buildUserAgent(browser.version()),
        locale: 'zh-CN',
        viewport: { width: 1600, height: 900 },
    });

    return {
        page: createCatalogPage(await context.newPage()),
        close: async (): Promise<void> => {
            clearActiveBrowser();
            await browser.close();
        },
    };
}

function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/** 日志缺省实现。插件尚未初始化时（单测直接调本层）静默丢弃, 不让日志成为失败点 */
function defaultLog(message: string): void {
    try {
        pluginState.logger.debug(message);
    } catch {
        /* 未初始化: 丢弃 */
    }
}

/** `warn` 的缺省实现。丢弃规则同 `defaultLog` */
function defaultWarn(message: string): void {
    try {
        pluginState.logger.warn(message);
    } catch {
        /* 未初始化: 丢弃 */
    }
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
 * ⚠️ **两处刻意不作废整轮的地方**（ADR-0006 / ADR-0007）:
 * - DOM 没刷新出来 —— 那些要兜底的通货记 `null`, 不牵连其他通货
 * - 详情取不到 / 挂单过少 —— 详情记 `null`, 价格照常（失真是唯一例外, 它**改写**价格）
 *
 * @throws 页面加载校验失败 / 区服切换未生效 / 详情面板没切到目标通货 / 配置里的组合页面上没有
 */
export async function scrapeCatalog(
    page: CatalogPage,
    catalog: CatalogConfig,
    deps: ScrapeDeps = {},
): Promise<GameOk> {
    const now = deps.now ?? ((): string => new Date().toISOString());
    const log = deps.log ?? defaultLog;
    const warn = deps.warn ?? defaultWarn;

    await page.open(catalog.pageUrl);

    // 区服标识来自级联接口: 拿不到就无法判断价格属于哪个区服, 继续跑只会产出无法校验的结果
    const zoneSpecIds = await page.readZoneSpecIds();
    assertZonesConfigured(catalog, zoneSpecIds);

    const names = catalog.currencyList.map(
        (currency) => currency.name,
    );
    const zones: ZoneRecord[] = [];
    /** 每个组合各自"接口里没有"的通货。游戏级 `missing` 由此取交集 */
    const missingPerZone: string[][] = [];

    for (const zonePath of catalog.zoneConfigs) {
        const specId = zoneSpecIds.get(zonePath.join('/'));
        const expected = await page.selectZone(zonePath);
        const rows = await readRowsIfNeeded(
            page,
            zonePath,
            names,
            expected,
            log,
        );

        const prices = buildPrices(
            catalog.currencyList,
            rows,
            expected,
        );

        await attachDetails(
            page,
            catalog.currencyList,
            prices,
            specId,
            log,
        );

        zones.push({
            zone: zonePath,
            // 读取时刻的粒度是**区服组合**, 不是游戏, 也不是整次抓取（见 CONTEXT.md）
            readAt: now(),
            prices,
        });

        // ⚠️ `missing` 的口径是「**接口响应里没有这个 `spuName`**」（ADR-0006 结论 5）,
        // 不是"DOM 里找不到这个名字"。后者把"选择器过期"误报成"配置写错";
        // 而接口的字段名是稳定的, 它没给就真的是站点上没有这个通货
        missingPerZone.push(
            names.filter((name) => !expected.has(name)),
        );
    }

    const missing = intersect(names, missingPerZone);

    // ⚠️ **全部通货都缺** 更像"接口整体改版"而不是"N 个名字全拼错"。`missing` 单独成行是
    // 配置写错唯一的可见信号, 而它在这两种情形下长得一模一样——这句话是唯一的区分线索
    if (names.length > 0 && missing.length === names.length) {
        warn(
            `${catalog.name} 的 ${names.length} 个通货在价格接口里一个都没有——` +
                '更像接口改版而不是名字全拼错，请核对接口字段',
        );
    }

    return {
        readAt: zones.reduce(
            (latest, zone) =>
                zone.readAt > latest ? zone.readAt : latest,
            '',
        ),
        zones,
        missing,
    };
}

/**
 * 只在**真的需要 DOM 兜底**时才去读列表。
 *
 * 主路径上价格全部来自接口响应, 因此既不读 DOM 也不需要等它渲染——这正是 ADR-0006 的
 * 收益兑现点: 渲染时序不再能影响任何一条落盘值。
 */
async function readRowsIfNeeded(
    page: CatalogPage,
    zonePath: string[],
    names: string[],
    expected: ZoneExpectation,
    log: (message: string) => void,
): Promise<RawCurrencyRow[]> {
    const fallbackNames = names.filter((name) => !expected.has(name));
    if (fallbackNames.length === 0) return [];

    const rendered = await page.waitForListRendered(expected, names);
    if (!rendered) {
        // ⚠️ 这里**不作废整个游戏**。走兜底的是接口没给的少数通货, 它们本来就只能记 `null`;
        // 把它们的问题升级成"整轮作废", 收益为零而代价是整个游戏的价格
        log(
            `「${zonePath.join(' / ')}」列表未渲染出接口返回的数据, ` +
                `以下通货将走 DOM 兜底且可能记 null: ${fallbackNames.join('、')}`,
        );
    }

    return page.readCurrencyRows();
}

/**
 * 逐个通货装配价格。
 *
 * ⚠️ **接口优先, 页面兜底**, 且接口说无报价时**不再看页面**（ADR-0006）: 按接口记是
 * **少一条数据**, 按页面记是**多一条可能过期的数据**, 本项目的取舍一贯是前者。
 *
 * ⚠️ `price` 只可能是正数或 `null`——**没有 `0`**。接口的 `ratioPrice === 0` 表示本区服
 * 无报价, 页面对应位置显示的本来就是占位符, 两者是同一件事（ADR-0006 结论 4）。
 */
function buildPrices(
    currencyList: CurrencyConfig[],
    rows: RawCurrencyRow[],
    expected: ZoneExpectation,
): PriceItem[] {
    return currencyList.map(({ name }): PriceItem => {
        const api = expected.get(name);
        if (api) return fromApi(name, api);

        const hit = rows.find((item) => item.name === name);

        return hit
            ? parseCurrencyRow(hit)
            : { name, price: null, unit: null };
    });
}

/** 把接口给的一条价格装配成 `PriceItem`。两个方向都是接口字段, 不做换算 */
function fromApi(name: string, api: ExpectedPrice): PriceItem {
    // 接口说本区服无报价 —— 不看页面
    if (!(api.ratioPrice > 0))
        return { name, price: null, unit: null };

    const countUnit = api.ratioUnit;
    const entry: PriceItem = {
        name,
        price: api.ratioPrice,
        unit: countUnit ? `${countUnit}/元` : null,
    };

    // 元价与主方向**同生共死**: 读不出就不产出这两个键, 而不是产出半个价格
    if (countUnit && api.rmbPrice !== null && api.rmbPrice > 0) {
        entry.rmbPrice = api.rmbPrice;
        entry.rmbUnit = `元/${countUnit}`;
    }

    return entry;
}

/**
 * 逐个通货取详情, 就地改写 `prices`。
 *
 * ⚠️ **无报价的通货不点详情**（ADR-0005 / 抓取源项目）: 详情要一次点击加一次面板等待,
 * 而"没有报价"的通货点进去多半是空面板。更重要的是它**不产生错值**——
 * `detail` 键不出现, 语义清楚。
 *
 * ⚠️ **详情失败不抛错**, 只留 `null`（`readCurrencyDetail` 内部已容错）。唯一能改写价格的
 * 是它的**挂单深度**, 由 `attachDetail` 施加（ADR-0007）。
 */
async function attachDetails(
    page: CatalogPage,
    currencyList: CurrencyConfig[],
    prices: PriceItem[],
    specId: string | undefined,
    log: (message: string) => void,
): Promise<void> {
    if (!specId) return;

    for (let index = 0; index < currencyList.length; index++) {
        const currency = currencyList[index] as CurrencyConfig;
        const base = prices[index] as PriceItem;

        if (!currency.detail || base.price === null) continue;

        const startedAt = Date.now();
        const fetch = await readDetailQuietly(
            page,
            currency.name,
            specId,
            log,
        );

        log(
            `  详情 ${currency.name}：` +
                (fetch.detail
                    ? `${fetch.detail.listings.length} 条挂单 / 成交量 ${fetch.detail.volume || '(未读到)'}`
                    : '(未取到)') +
                `　${describeDepth(fetch)}　耗时 ${Date.now() - startedAt}ms`,
        );

        prices[index] = attachDetail(base, fetch.detail, fetch.thin);
    }
}

/**
 * 取详情, **失败只记日志、不往上抛**。
 *
 * ⚠️ 这是 ADR-0005 结论 5（详情失败不判游戏失败）的落点。详情比价格多做一次点击与一次
 * 面板等待, 失败面大得多, 而它**不产生错值**——"没去取"与"取不到"在数据里可区分。
 * 让一个冷门通货的详情超时把整份价格赔进去（游戏级原子性会把整轮作废）收益为零。
 *
 * 唯一需要往上冒的是"面板没切到目标通货"与"卡片读到了却没有一张有价格"（选择器过期）,
 * 它们同样在这里被拦下——但会**响亮地**记一行, 因为它们指向的是站点改版而非偶发抖动。
 */
async function readDetailQuietly(
    page: CatalogPage,
    currencyName: string,
    specId: string,
    log: (message: string) => void,
): Promise<DetailFetch> {
    try {
        return await page.readCurrencyDetail(
            currencyName,
            specId,
            DETAIL_TOP_N,
        );
    } catch (error) {
        log(`  详情 ${currencyName} 取不到：${messageOf(error)}`);

        return { detail: null, thin: null, count: null, total: null };
    }
}

/**
 * 把挂单深度打成一句人话。
 *
 * ⚠️ **这段日志是阈值 `15` 唯一能被检验的地方。** 阈值只来自抓取源项目的实测, 插件侧的
 * 三个游戏未各自验证; `total` 到底给不给也只能靠实测——不记下来, 阈值不合适时无从发现。
 */
function describeDepth(fetch: DetailFetch): string {
    if (fetch.count === null) return '挂单总数未知（响应没到）';

    const source =
        fetch.total === null ? '（接口未给 total，按 items 数）' : '';

    return (
        `挂单总数 ${fetch.count}${source}，` +
        (fetch.thin === true ? '过少 → 价格记失真' : '够')
    );
}

/** 配置的挂单条数上限。**是常量不是配置项**——行数偏多时的收紧方式是改渲染, 不是改数据形状 */
export const DETAIL_TOP_N = 5;

/**
 * 提前校验配置: 组合写错时立刻给出可用清单, 而不是卡到点击超时。
 *
 * 这是配置写错时**唯一能在抓取阶段被发现**的形态——`zoneConfigs` 里的组合在页面上不存在。
 */
function assertZonesConfigured(
    catalog: CatalogConfig,
    zoneSpecIds: Map<string, string>,
): void {
    const unknown = catalog.zoneConfigs.filter(
        (zone) => !zoneSpecIds.has(zone.join('/')),
    );
    if (unknown.length === 0) return;

    throw new Error(
        `${catalog.name} 的 zoneConfigs 中存在页面上没有的组合：` +
            `${unknown.map((zone) => zone.join('/')).join('、')}\n` +
            `页面可选组合：${[...zoneSpecIds.keys()].join('、')}`,
    );
}

/**
 * 游戏级 `missing` = 各组合"接口里没有"的**交集**（§7.2）。
 *
 * ⚠️ **是交集不是并集**: 不同区服提供的通货本来就不同（某通货可能只在国服有）, 所以
 * "某个组合缺某通货"是正常业务差异。真正指向配置写错（通货名拼错）的信号是
 * "**所有组合都缺同一个名字**"——这是该类错误唯一能让用户发现的途径, 因为被过滤掉的
 * 行在消息里看不见。
 *
 * ⚠️ 按**配置清单**的顺序输出, 而不是按发现顺序: 消息里的呈现顺序应当是配置说了算。
 */
function intersect(
    names: string[],
    missingPerZone: string[][],
): string[] {
    return names.filter((name) =>
        missingPerZone.every((missing) => missing.includes(name)),
    );
}
