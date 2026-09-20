/**
 * `CatalogPage` 的真实实现 —— 与站点页面打交道的那一层
 *
 * ⚠️ **本模块只能在真机上验证**。这里每一步的时序（等接口响应、等选择器回读）都是照着
 * **实测行为**写的, 单测的 DOM 环境复现不了它们。改动本模块后必须跑一次真机抓取。
 *
 * 三道静默错值防线的现状（ADR-0006 结论 6 重排过, 不是原样保留）:
 * 1. **页面级加载校验**（`assertPageReady`）—— 保留。站点按 UA 拦截时页面是空壳。
 * 2. **DOM 与价格接口交叉比对** —— **已删除**。价格改由接口定, 它的比对对象消失了;
 *    走 DOM 兜底的那些通货恰恰是接口没给的, 没有接口值可比。留着只会制造误判。
 *    `waitForListRendered` 保留下来, 但**职责变成了「DOM 刷新了没有」**, 且只在需要
 *    DOM 兜底时才调用, 失败也不再让整轮作废。
 * 3. **切换区服后回读选择器**（`waitForZoneSelected`）—— 保留, 但**从判据降级为断言**:
 *    区服归属已由请求体的 `specIds` 唯一确定, 回读现在只负责在失败时给出更清楚的报错。
 *
 * 另外按位置而非颜色类定位价格行（见 `parse.ts` 的选择器）。
 */

import type { Page, Response } from 'playwright-core';
import type {
    CatalogPage,
    DetailFetch,
    ZoneExpectation,
} from './index';
import {
    CURRENCY_SELECTORS,
    DETAIL_SELECTORS,
    hasRenderedExpected,
    parseZoneSpecIds,
    readCurrencyList,
    readDetailPanel,
    readListingEntries,
    type CascadeNode,
} from './parse';
import {
    buildCurrencyDetail,
    isThinMarket,
    parseListingRows,
    readListingCount,
    readResponseTotal,
    readTopListings,
    type DetailResponse,
} from './detail';

/**
 * 价格接口路径。切换区服后页面会重新请求它, 返回左侧列表的全部通货价格。
 * 用它作为「新数据是否到位」的锚点, 替代固定时长的硬等待。
 */
const PRICE_API_PATH = '/c2c-web/v1/common/currency-spu-price-list';

/**
 * 级联属性接口路径。首屏返回「区域/赛季/难度」的完整选项树, 叶子节点带区服标识。
 *
 * ⚠️ 选项树是**按游戏各自返回**的, 换游戏后必须重新解析一次。
 */
const CASCADE_API_PATH = '/c2c-web/v1/common/get-cascade-attribute';

/**
 * 挂单详情接口路径。点开通货面板时页面会请求它, 返回该通货的挂单列表。
 *
 * ⚠️ **它只发一次**：缓存命中的切换压根不发请求（实测）——所以"等响应"只能作为详情
 * 取值的**优先来源**, 等不到时必须退回 DOM, 不能当成唯一判据。
 */
const DETAIL_API_PATH = '/c2c-web/v1/currency/spu-list-v2';

/** 单次网络等待的上限 */
const NETWORK_TIMEOUT_MS = 20_000;

/**
 * 详情响应的等待上限。
 *
 * ⚠️ 这个值**刻意短**: 缓存命中的通货压根不发请求, 长等毫无意义（实测每条白等 10 秒,
 * 而全量开启详情时这个代价要乘上通货数）。等不到就走 DOM 兜底。
 */
const DETAIL_TIMEOUT_MS = 3_000;

/** 失败重试次数（不含首次尝试） */
const RETRY_TIMES = 2;

/** 重试间隔 */
const RETRY_DELAY_MS = 1000;

/** 等待列表渲染出接口数据: 最多采样 25 次、每次间隔 200ms, 上限 5 秒 */
const RENDER_SAMPLES = 25;
const RENDER_INTERVAL_MS = 200;

/** 点击通货后等待详情面板回读为目标通货的上限 */
const DETAIL_PANEL_TIMEOUT_MS = 5_000;
const DETAIL_PANEL_INTERVAL_MS = 100;

/** 页面加载后等待关键元素出现的上限 */
const PAGE_READY_TIMEOUT_MS = 30_000;

/** 点击后等待级联选择器回读为目标区服的上限 */
const SELECTION_TIMEOUT_MS = 10_000;

/** 级联选择器（「区域 / 赛季 / 难度」） */
const CASCADER = '.n-base-selection';
const CASCADER_SUBMENU = '.n-cascader-submenu';
const CASCADER_OPTION_LABEL = '.n-cascader-option__label';

/** 把 playwright 的 page 包成一个 `CatalogPage` */
export function createCatalogPage(page: Page): CatalogPage {
    /** 区服路径 → 区服标识。`open` 时解析, `selectZone` 要用 */
    let zoneSpecIds = new Map<string, string>();

    /**
     * 区服标识 → 「通货名 → 期望价格」。来自价格接口的响应。
     *
     * 前端对每个区服**只请求一次**: 再次切回本页已加载过的区服会命中缓存、不发请求
     * （实测表现: 切换成功、DOM 也渲染正确, 但等不到任何响应）。因此"等响应"只能作为
     * 获取期望值的手段之一, 拿到过的就复用, 不能当成唯一判据。
     */
    const expectedByZone = new Map<string, ZoneExpectation>();

    return {
        async open(pageUrl: string): Promise<void> {
            // 两个监听都必须在 goto **之前**挂上, 否则会漏掉首屏响应。
            // 统一 catch 掉失败: 拦截场景下由后面的显式校验负责报错
            const cascadeResponse = page
                .waitForResponse(
                    (res) =>
                        res.url().includes(CASCADE_API_PATH) &&
                        res.status() === 200,
                    { timeout: NETWORK_TIMEOUT_MS },
                )
                .catch(() => null);

            const firstPriceResponse = page
                .waitForResponse(
                    (res) =>
                        res.url().includes(PRICE_API_PATH) &&
                        res.status() === 200,
                    { timeout: NETWORK_TIMEOUT_MS },
                )
                .catch(() => null);

            await page.goto(pageUrl, {
                waitUntil: 'domcontentloaded',
            });

            // ⚠️ **页面级加载校验**（§8.3 硬约束 3）: 站点按 UA 拦截时页面是个空壳,
            // 连 DOM 都渲染不出来。这里必须显式失败, 否则会把整份结果静默写成空值。
            await assertPageReady(page);

            const cascade = await cascadeResponse;
            if (!cascade) {
                throw new Error(
                    `未能获取级联属性接口响应（${CASCADE_API_PATH}），无法确认区服标识，已中止以避免取到旧数据`,
                );
            }

            const cascadeBody = (await cascade.json()) as {
                data?: CascadeNode[];
            };
            zoneSpecIds = parseZoneSpecIds(cascadeBody.data);

            // 首屏那次请求返回的就是**默认区服**的价格, 必须收下——否则当默认区服恰好也出现
            // 在 zoneConfigs 里时（火炬之光就是这种情况）, 那个组合必然等到超时。
            const first = await firstPriceResponse;
            if (first)
                await recordZoneExpected(first, expectedByZone);
        },

        async readZoneSpecIds(): Promise<Map<string, string>> {
            return zoneSpecIds;
        },

        async selectZone(
            zonePath: string[],
        ): Promise<ZoneExpectation> {
            const specId = zoneSpecIds.get(zonePath.join('/'));
            if (!specId)
                throw new Error(
                    `页面上没有区服「${zonePath.join(' / ')}」`,
                );

            await withRetry(
                async (attempt) => {
                    // 重试时先收起残留的面板, 保证从干净状态重新选择
                    if (attempt > 0) await resetCascader(page);

                    // 已经拿到过该区服的期望值就不必再等响应（命中缓存的切换不发请求）;
                    // 没拿到过则**先挂监听再触发切换**, 否则会漏掉本次响应。
                    const pending = expectedByZone.has(specId)
                        ? null
                        : waitForZonePrice(page, specId);
                    pending?.catch(() => {});

                    await clickThroughCascader(page, zonePath);
                    // 断言点击真的生效了。区服归属已由请求体的 `specIds` 确定, 这一步现在
                    // 只负责"失败时报得清楚"——它不再是正确性的判据
                    await waitForZoneSelected(page, zonePath);

                    if (pending)
                        await recordZoneExpected(
                            await pending,
                            expectedByZone,
                        );
                },
                `切换到 ${zonePath.join(' / ')}`,
            );

            const expected = expectedByZone.get(specId);
            if (!expected) {
                throw new Error(
                    `未能确认「${zonePath.join(' / ')}」的价格数据（既没捕获到响应, 也没有可复用的期望值）`,
                );
            }

            return expected;
        },

        async readCurrencyRows() {
            return page.evaluate(
                readCurrencyList,
                CURRENCY_SELECTORS,
            );
        },

        async waitForListRendered(expected, currencyNames) {
            // ⚠️ **只在需要 DOM 兜底时才调用**（编排层负责判）。它现在的唯一职责是
            // 「DOM 刷新了没有」: 切换区服时列表会先清空再重绘, 响应刚回来时读到的可能是
            // 空列表或上一个区服的旧值。
            //
            // 比对必须**同方向**: DOM 读的是第二行（比率价）, 所以期望值也取 `ratioPrice`。
            // 拿元价来比是两个方向的比对, 元方向那 4 位小数的舍入会让它永远对不上。
            const ratioPrices = new Map(
                [...expected].map(([name, item]) => [
                    name,
                    item.ratioPrice,
                ]),
            );

            // 判据本身是纯逻辑（`hasRenderedExpected`）, 放在 parse.ts 里单测钉死;
            // 这里只剩"采样若干次直到对得上"的页面时序
            for (let i = 0; i < RENDER_SAMPLES; i++) {
                const rows = await page.evaluate(
                    readCurrencyList,
                    CURRENCY_SELECTORS,
                );
                if (
                    hasRenderedExpected(
                        rows,
                        ratioPrices,
                        currencyNames,
                    )
                )
                    return true;

                await delay(RENDER_INTERVAL_MS);
            }

            return false;
        },

        async readCurrencyDetail(
            currencyName: string,
            specId: string,
            topN: number,
        ): Promise<DetailFetch> {
            // 先把监听挂上: 缓存命中的切换不会发请求, 此时等不到响应是正常的, 后面用 DOM 兜底。
            // `catch` 挂在**这里**而不是 await 处: 可能永远不 await 它（短路返回）
            const pending = waitForDetail(page, specId).catch(
                () => null,
            );

            const clicked = await clickCurrencyRow(
                page,
                currencyName,
            );
            if (!clicked) {
                return {
                    detail: null,
                    thin: null,
                    count: null,
                    total: null,
                };
            }

            // 点击是否生效**不由网络判**: 等面板头部回读为目标通货。
            // 读错了面板比读不到更糟——那是隔壁通货的挂单, 而它看起来完全正常
            if (!(await waitForDetailPanel(page, currencyName))) {
                throw new Error(
                    `点击「${currencyName}」后详情面板未切换到该通货`,
                );
            }

            // 挂单优先取接口（全精度原始值）, 接口没等到时才退回页面文本。
            // 因此只等一小会儿——缓存命中的通货压根不发请求, 长等毫无意义
            const body = await withShortGrace(
                pending,
                DETAIL_TIMEOUT_MS,
            );

            // 条数只从接口响应数（产物里的挂单被 topN 截断, 数出来必然偏小）。
            // `total` 单独带出来是给日志用的: 接口到底给不给这个字段, 只能靠实测
            const count =
                body === null ? null : readListingCount(body);
            const total =
                body === null ? null : readResponseTotal(body);
            const thin = body === null ? null : isThinMarket(body);

            const panel = await page.evaluate(
                readDetailPanel,
                DETAIL_SELECTORS,
            );
            const rows = await page.evaluate(
                readListingEntries,
                DETAIL_SELECTORS,
            );
            const listings = listingsOf(rows, body, topN, specId);

            // ⚠️ **响亮失败**（ADR-0005 结论 2 的形态守卫）: 卡片读到了, 却一张都读不出价格。
            // 不报的话, 表现是一份"这个通货没有挂单"的空详情——而那与"站点上真的没挂单"
            // 长得一模一样。
            //
            // 它只在**接口也没给**的时候才可能成立: 接口给了挂单时 `listings` 非空,
            // DOM 选择器坏不坏都无所谓（价格不由它决定）, 那时报错只会制造假警报。
            if (listings.length === 0 && rows.length > 0) {
                throw new Error(
                    `「${currencyName}」详情面板读到了 ${rows.length} 张卡片，但没有一张能读出价格行` +
                        `（价格区选择器可能已过期：${DETAIL_SELECTORS.cardPriceBox}）`,
                );
            }

            // ⚠️ 「面板为空」在这里**不早退**: 0 条挂单是最该判失真的情形（`0 < 15`）,
            // 而条数已经在上面数出来了。只有当**两个来源都没有任何内容**时才记 `null`
            if (listings.length === 0 && !panel.volumeText) {
                return { detail: null, thin, count, total };
            }

            return {
                detail: buildCurrencyDetail(
                    panel.volumeText,
                    listings,
                ),
                thin,
                count,
                total,
            };
        },
    };
}

/**
 * 挂单：**接口优先, DOM 兜底**。
 *
 * ⚠️ **接口那边不做"按位配对"**。抓取源项目加过一次"条数严格相等才逐条把接口价格扣到 DOM
 * 结果上"的约束, 那是为了防错配——但它防的是**配对**这个动作本身引入的风险。接口既然可以
 * 独立取值（按 `specValues[].id` 过滤出目标区服、按响应顺序取前 N 条）, 那一层配对就整个
 * 不必存在, 比"配对 + 防错配"简单得多也更安全。
 *
 * DOM 兜底路径只在**接口一个都没给出**时启用（响应没等到、或返回的挂单都不属于本区服）。
 */
function listingsOf(
    rows: ReturnType<typeof readListingEntries>,
    body: DetailResponse | null,
    topN: number,
    specId: string,
): ReturnType<typeof readTopListings> {
    const fromDom = parseListingRows(rows, topN);
    if (body === null) return fromDom;

    const fromApi = readTopListings(body, topN, specId);
    if (fromApi.length > 0) return fromApi;

    // 接口给了响应但没有属于本区服的挂单: 仍然退回 DOM。
    // 这里**不做 `enrichListingsFromResponse`** 那种逐条替换——它要求条数严格相等,
    // 而"条数不等"恰是这一次的真实情况
    return fromDom;
}

/** 关键元素出现才算页面真的加载出来了 */
async function assertPageReady(page: Page): Promise<void> {
    try {
        await page.waitForSelector(CASCADER, {
            state: 'visible',
            timeout: PAGE_READY_TIMEOUT_MS,
        });
        await page.waitForSelector(CURRENCY_SELECTORS.itemName, {
            state: 'visible',
            timeout: PAGE_READY_TIMEOUT_MS,
        });
    } catch {
        const text = await page
            .evaluate(() =>
                document.body.innerText.trim().slice(0, 200),
            )
            .catch(() => '');
        const ua = await page
            .evaluate(() => navigator.userAgent)
            .catch(() => '(读取失败)');

        throw new Error(
            `页面未能加载出内容（可能被拦截）。UA=${ua}\n页面文本片段：${text || '(空)'}`,
        );
    }
}

/**
 * 打开级联选择器, 按顺序逐级点击选中。
 *
 * 每一级的可选项依赖上一级的选择, 因此必须一级一级点击。
 */
async function clickThroughCascader(
    page: Page,
    zonePath: string[],
): Promise<void> {
    await page.click(CASCADER);
    await page.waitForSelector(CASCADER_SUBMENU, {
        state: 'visible',
    });

    for (let level = 0; level < zonePath.length; level++) {
        const value = zonePath[level] as string;

        // 等第 level 列渲染出目标选项本身, 而不是等固定时长——
        // 目标文本就位才说明该列已换成上一级选中后的内容
        await page.waitForFunction(
            ({ level, value }) => {
                const columns = document.querySelectorAll(
                    '.n-cascader-submenu',
                );
                if (columns.length <= level) return false;

                return [
                    ...(columns[level]?.querySelectorAll(
                        '.n-cascader-option__label',
                    ) ?? []),
                ].some(
                    (el) =>
                        (el as HTMLElement).innerText.trim() ===
                        value,
                );
            },
            { level, value },
        );

        const option = page
            .locator(CASCADER_SUBMENU)
            .nth(level)
            .locator(`${CASCADER_OPTION_LABEL}:text-is("${value}")`);

        await option.waitFor({ state: 'visible' });
        await option.click();

        // 最后一级点击完成后菜单关闭
        if (level === zonePath.length - 1) {
            await page
                .waitForSelector(CASCADER_SUBMENU, {
                    state: 'hidden',
                })
                .catch(() => {});
        }
    }
}

/**
 * 断言级联选择器**回读**为目标区服。
 *
 * ⚠️ **它不是区服归属的判据**——归属由请求体的 `specIds` 唯一确定, 比"页面看起来切过去了"
 * 硬。保留它的唯一理由是失败时报得更清楚: 点击被吞掉（选项未渲染完、面板状态残留）时,
 * 这里能直接说出"点的是 A、页面显示 B", 而不是让下游拿一个超时去猜。
 */
async function waitForZoneSelected(
    page: Page,
    zonePath: string[],
): Promise<void> {
    const expected = zonePath.join('/');

    try {
        await page.waitForFunction(
            ({ expected }) => {
                const el = document.querySelector(
                    '.n-base-selection',
                );
                // 回读文本形如 `国服 / 赛季 / 普通`, 去掉分隔符两侧空白后与路径比较
                return (
                    !!el &&
                    (el as HTMLElement).innerText.replace(
                        /\s+/g,
                        '',
                    ) === expected
                );
            },
            { expected },
            { timeout: SELECTION_TIMEOUT_MS },
        );
    } catch {
        const actual = await page
            .evaluate(
                () =>
                    (
                        document.querySelector(
                            '.n-base-selection',
                        ) as HTMLElement | null
                    )?.innerText ?? '(找不到选择器)',
            )
            .catch(() => '(读取失败)');

        throw new Error(
            `切换后选择器显示为「${actual.trim()}」，与目标「${expected}」不符，点击可能未生效`,
        );
    }
}

/**
 * 等待价格接口返回**目标区服**的数据。
 *
 * 区服标识在**请求体**的 `specIds` 里（响应本身不带区服字段）, 据此确认这次响应属于本次
 * 切换, 而不是站点变慢时残留的上一次结果——后者正是固定硬等待最危险的失败模式:
 * 取到旧值且不报错。
 *
 * ⚠️ **必须按请求体匹配, 不能只按 URL。** 切区服时上一个区服的响应可能还在飞, 只按 URL
 * 会逮错, 产出**归属正确、数值是隔壁区服**的错值（ADR-0006 结论 1 的第二条理由）。
 *
 * ⚠️ 必须在触发切换**之前**调用并持有返回的 Promise, 否则会漏掉响应。
 */
function waitForZonePrice(
    page: Page,
    specId: string,
): Promise<Response> {
    return page.waitForResponse(
        (response) => {
            if (
                response.status() !== 200 ||
                !response.url().includes(PRICE_API_PATH)
            )
                return false;

            return requestSpecIds(response).includes(specId);
        },
        { timeout: NETWORK_TIMEOUT_MS },
    );
}

/**
 * 等待**目标区服**的挂单详情响应。
 *
 * 同 `waitForZonePrice`, 按请求体的 `specIds` 匹配——面板之间切换很快, 只按 URL 会逮到
 * 上一个通货的响应。
 */
function waitForDetail(
    page: Page,
    specId: string,
): Promise<Response> {
    return page.waitForResponse(
        (response) => {
            if (
                response.status() !== 200 ||
                !response.url().includes(DETAIL_API_PATH)
            )
                return false;

            return requestSpecIds(response).includes(specId);
        },
        { timeout: NETWORK_TIMEOUT_MS },
    );
}

/** 读请求体里的 `specIds`。读不出（免 body 的 GET、非 JSON）时返回空数组 */
function requestSpecIds(response: Response): string[] {
    try {
        const body = JSON.parse(
            response.request().postData() ?? '{}',
        ) as { specIds?: unknown };

        return Array.isArray(body.specIds)
            ? body.specIds.map(String)
            : [];
    } catch {
        return [];
    }
}

/**
 * 从价格接口响应中读出每个通货的期望价格, 按**请求体**里的 `specIds` 记为哪个区服的期望值。
 *
 * 区服标识在请求体里、不在响应里, 所以必须读 `postData()` 才能知道这份数据属于谁。
 *
 * ⚠️ 取的是 **`ratioPrice`（主方向）**, 不是 `rmbPrice`。改造前取的是后者, 于是
 * `waitForListRendered` 变成了**跨方向的比对**——元方向只有 4 位小数, 舍入让它对不上。
 */
async function recordZoneExpected(
    response: Response,
    cache: Map<string, ZoneExpectation>,
): Promise<void> {
    const specIds = requestSpecIds(response);
    if (specIds.length === 0) return;

    const items = (await response.json())?.data?.items ?? [];
    const expected: ZoneExpectation = new Map(
        items.map(
            (item: {
                spuName: string;
                ratioPrice?: number;
                ratioUnit?: string;
                rmbPrice?: number;
            }) => [
                item.spuName,
                {
                    ratioPrice:
                        typeof item.ratioPrice === 'number'
                            ? item.ratioPrice
                            : 0,
                    ratioUnit:
                        typeof item.ratioUnit === 'string'
                            ? item.ratioUnit
                            : null,
                    rmbPrice:
                        typeof item.rmbPrice === 'number'
                            ? item.rmbPrice
                            : null,
                },
            ],
        ),
    );

    for (const specId of specIds) cache.set(specId, expected);
}

/** 在左侧列表里点开目标通货的面板。找不到该行时返回 `false` */
async function clickCurrencyRow(
    page: Page,
    currencyName: string,
): Promise<boolean> {
    const index = await page.evaluate(
        ({ sidebar, itemName, name }) => {
            const list = [...document.querySelectorAll(sidebar)].find(
                (el) => el.querySelector(itemName),
            );
            if (!list) return -1;

            return [...list.children].findIndex(
                (item) =>
                    item
                        .querySelector(itemName)
                        ?.textContent?.trim() === name,
            );
        },
        {
            sidebar: CURRENCY_SELECTORS.sidebar,
            itemName: CURRENCY_SELECTORS.itemName,
            name: currencyName,
        },
    );

    if (index < 0) return false;

    await page
        .locator(`${CURRENCY_SELECTORS.sidebar} > *`)
        .first()
        .nth(index)
        .click()
        .catch(() => {});
    // 上一步的 click 失败只可能是行不见了; 真正的判据是下面的面板回读

    return true;
}

/**
 * 等详情面板的标题回读为目标通货。
 *
 * ⚠️ **这一步比"等接口响应"更硬**: 缓存命中的切换不发任何请求, 只有面板标题能证明
 * "现在显示的是我要的那个通货"。读错面板的后果是拿到隔壁通货的挂单, 而它看起来完全正常。
 */
async function waitForDetailPanel(
    page: Page,
    currencyName: string,
): Promise<boolean> {
    for (
        let waited = 0;
        waited < DETAIL_PANEL_TIMEOUT_MS;
        waited += DETAIL_PANEL_INTERVAL_MS
    ) {
        const panel = await page.evaluate(
            readDetailPanel,
            DETAIL_SELECTORS,
        );
        if (panel.name === currencyName) return true;

        await delay(DETAIL_PANEL_INTERVAL_MS);
    }

    return false;
}

/**
 * 等一个"可能永远不来的" Promise, 到点就放弃。
 *
 * 用于详情响应: 缓存命中的通货压根不发请求, 长等毫无意义。
 */
function withShortGrace<T>(
    promise: Promise<T | null>,
    ms: number,
): Promise<T | null> {
    return Promise.race([
        promise,
        new Promise<null>((resolve) => {
            setTimeout(() => resolve(null), ms);
        }),
    ]);
}

/** 收起可能处于展开状态的级联面板, 让重试从干净状态重新开始选择 */
async function resetCascader(page: Page): Promise<void> {
    await page.keyboard.press('Escape').catch(() => {});
    await page
        .waitForSelector(CASCADER_SUBMENU, {
            state: 'hidden',
            timeout: 5000,
        })
        .catch(() => {});
}

/**
 * 通用重试。用于网络抖动、临时反爬这类「重试即可恢复」的失败,
 * 避免单次偶发失败让整轮抓取作废。
 */
async function withRetry(
    fn: (attempt: number) => Promise<void>,
    label: string,
): Promise<void> {
    let lastError: unknown;

    for (let attempt = 0; attempt <= RETRY_TIMES; attempt++) {
        try {
            return await fn(attempt);
        } catch (error) {
            lastError = error;
            if (attempt === RETRY_TIMES) break;

            // 这是重试前的退避, 不是在等页面, 因此用 setTimeout 而非 page.waitForTimeout
            await delay(RETRY_DELAY_MS);
        }
    }

    throw new Error(
        `${label} 失败：${lastError instanceof Error ? lastError.message : String(lastError)}`,
    );
}

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
