/**
 * 抓取层纯函数
 *
 * 本模块**无副作用、不碰 DOM 全局、不碰文件**——它只做"给我一段页面文本 / 一个响应对象,
 * 我告诉你数据是什么"这一件事。抓取主流程 (`scraper/index.ts`) 负责所有 IO 与页面交互。
 *
 * 拆出来的理由是可测性 (见设计文档 §18)。抓取层里"页面点击有没有生效""渲染完没有"
 * 只能在真机上验; 而"读到的这个数字到底对不对"是纯函数问题, 必须在这里钉死——
 * 静默错值 (读到一个看似合理、实则错误的数字) 是抓取层最危险的失败模式。
 */

/**
 * 解析页面上的价格文本为数值。
 *
 * ⚠️ **不能直接用 `Number.parseFloat`**。它对 `"1,234.5"` 返回 `1`
 * (遇到逗号就停止), 而 `Number.isFinite(1)` 为真——检查不出来, 于是 1234.5 被静默
 * 写成 1。这是本项目修掉的一处「构建通过、静默错值」的漏洞 (设计文档 §8.3)。
 *
 * 因此先剥离千分位再解析, 并**把结果规范化回字符串与原文比对**; 对不上就返回 `null`
 * (记为"本次未取到"), 由调用方告警。宁可少一条数据, 不可多一条错数据。
 *
 * @returns 解析成功时的数值; 无法确信解析正确时返回 `null`
 */
export function parsePriceText(raw: string): number | null {
    const text = raw.trim();
    if (!text) return null;

    const stripped = stripThousands(text);
    if (stripped === null) return null;

    const value = Number(stripped);
    if (!Number.isFinite(value)) return null;

    // 规范化回读比对。容忍尾随零 (`1.2300` ≡ `1.23`), 但**不容忍精度丢失**——
    // 超长数字会被 Number 静默截断 (`9007199254740993` → `...992`), 那种读数是错的。
    if (canonicalize(stripped) !== canonicalize(String(value))) return null;

    return value;
}

/** 级联属性接口的一个选项节点。**只有叶子**带非空的 `dataValue`（区服标识） */
export interface CascadeNode {
    dataValueLabel?: string;
    dataValue?: string;
    children?: CascadeNode[];
}

/**
 * 从级联属性响应中解析「区服路径 → 区服标识」映射。
 *
 * 价格接口的响应本身**不带区服字段**——区服标识在**请求体**的 `specIds` 里, 所以
 * 要判断"这份价格属于哪个区服", 只能拿站点给的这棵选项树当对照表 (见 CONTEXT.md
 * 的「区服标识 (specId)」)。
 *
 * ⚠️ **选项树是按游戏各自返回的**, 换游戏后必须重新解析, 不能沿用上一个游戏的映射。
 * ⚠️ 层级依次是区域、赛季、难度, 但**层数随游戏而变**（流放之路 3 级、火炬之光 2 级),
 * 因此这里按树递归, 不假设固定深度。
 *
 * @param nodes 响应 `data` 字段（顶层即区域数组）
 * @returns 形如 `'国服/赛季/普通' → '3794868'`
 */
export function parseZoneSpecIds(nodes: CascadeNode[] | undefined | null): Map<string, string> {
    const map = new Map<string, string>();

    const walk = (list: CascadeNode[] | undefined, pathPrefix: string[]): void => {
        for (const node of list ?? []) {
            const currentPath = [...pathPrefix, node.dataValueLabel ?? ''];
            // 中间层级没有标识, 只有叶子有——用真值判断即可, 空串与 undefined 都不入映射
            if (node.dataValue) map.set(currentPath.join('/'), node.dataValue);
            walk(node.children, currentPath);
        }
    };

    walk(nodes ?? [], []);

    return map;
}

// ==================== 浏览器侧采集 ====================

/** 站点选择器。价格行的颜色类随价格来源变化, 因此**按位置**取容器下的第一个 div */
export interface CurrencySelectors {
    /** 左侧通货列表容器 */
    sidebar: string;
    /** 通货名 */
    itemName: string;
    /** 价格容器（内含价格行与反向价两行） */
    itemPriceBox: string;
    /** 无价格时的占位符（容器内只有它） */
    itemEmptyPrice: string;
    /** 价格行 = 价格容器下的**第一个** div */
    itemPrice: string;
}

export const CURRENCY_SELECTORS: CurrencySelectors = {
    sidebar: '.flex.flex-col.overflow-y-auto.flex-1',
    itemName: '.text-h5.c-text-1.truncate',
    itemPriceBox: '.flex.flex-col.items-end.justify-center.h-40px.shrink-0',
    itemEmptyPrice: '.c-text-3',
    // `:scope > div` 而不是匹配颜色类: 该行颜色类随价格来源变化 (c-success-text-c /
    // c-trade-text-c / c-text-2), 照颜色类匹配会在站点换样式时静默读不到价格。
    // 容器内第一行是 `1 <基准单位> = <价格> <计价单位>`, 第二行是反向价, 只取第一行。
    itemPrice: ':scope > div',
};

/** 采集到的一行：**原始文本, 尚未解析**。见 `readCurrencyList` 的说明 */
export interface RawCurrencyRow {
    name: string;
    /** 价格文本; `null` = 该行无报价（页面显示占位符） */
    priceText: string | null;
    baseUnit: string | null;
    quoteUnit: string | null;
}

/**
 * 采集左侧列表里每一行通货的**原始文本**。
 *
 * ⚠️ **本函数在浏览器上下文里执行**（`page.evaluate(readCurrencyList, CURRENCY_SELECTORS)`），
 * 因此有两条硬约束:
 * 1. **必须是自包含的**——`page.evaluate` 只序列化函数体, 闭包与模块级引用都拿不到。
 *    选择器因此靠参数传入, 而不能直接读 `CURRENCY_SELECTORS`。
 * 2. **不做数值解析**——解析要用 `parsePriceText`（千分位剥离 + 规范化回读比对）, 而那个
 *    函数在 Node 侧。把解析放这儿就得在浏览器里再抄一份, 两份实现迟早漂移, 而漂移的表现
 *    正是本项目要防的静默错值。所以这里只搬运文本, 解析交给 `parseCurrencyRow`。
 */
export function readCurrencyList(s: CurrencySelectors): RawCurrencyRow[] {
    const sidebar = [...document.querySelectorAll(s.sidebar)].find((el) =>
        el.querySelector(s.itemName),
    );
    if (!sidebar) return [];

    return [...sidebar.children].map((item): RawCurrencyRow => {
        const nameEl = item.querySelector(s.itemName);
        const name = nameEl ? (nameEl as HTMLElement).innerText.trim() : '';

        const priceBox = item.querySelector(s.itemPriceBox);
        let priceText: string | null = null;
        let baseUnit: string | null = null;
        let quoteUnit: string | null = null;

        // 无报价时容器内只有占位符, 根本没有价格行
        if (priceBox && !priceBox.querySelector(s.itemEmptyPrice)) {
            const priceEl = priceBox.querySelector(s.itemPrice);
            if (priceEl) {
                // 依次为: 单位数量、基准单位、等号、价格、计价单位
                const spans = [...priceEl.querySelectorAll('span')].map((el) =>
                    (el as HTMLElement).innerText.trim(),
                );
                const [, base, , value, quote] = spans;
                priceText = value ?? null;
                baseUnit = base ?? null;
                quoteUnit = quote ?? null;
            }
        }

        return { name, priceText, baseUnit, quoteUnit };
    });
}

// ==================== Node 侧解析 ====================

/** 一条价格记录，与 `data.json` 的 `zones[].prices[]` 同构 */
export interface PriceItem {
    name: string;
    /** 数字 = 有效报价; **`null` = 本次未取到**（与真实报 `0` 区分开） */
    price: number | null;
    /** 如 `元/个`; 无报价时为 `null` */
    unit: string | null;
}

/**
 * 把采集到的原始行解析成价格记录。
 *
 * 单位由页面的「计价单位 / 基准单位」拼成 (设计文档 §7.2)。价格走 `parsePriceText`,
 * 因此千分位与精度问题在这里被统一挡住; 挡下时**整条记 `null`**——宁可少一条数据,
 * 不可多一条错数据。
 */
export function parseCurrencyRow(row: RawCurrencyRow): PriceItem {
    const price = row.priceText === null ? null : parsePriceText(row.priceText);

    if (price === null) return { name: row.name, price: null, unit: null };

    const unit = row.quoteUnit && row.baseUnit ? `${row.quoteUnit}/${row.baseUnit}` : null;

    return { name: row.name, price, unit };
}

// ==================== 渲染完成判定 ====================

/** 两个价格是否一致。容忍前端可能的浮点格式化差异 (`1.23` ≡ `1.2300`), 但不容忍数量级偏差 */
function isPriceEqual(a: number, b: number): boolean {
    return Math.abs(a - b) <= Math.max(1e-9, Math.abs(b) * 1e-6);
}

/**
 * 判断 DOM 读到的行是否**已经渲染出接口返回的价格**。
 *
 * 这是「响应到达 ≠ DOM 已更新」这条防线的判据: 切换区服时列表会先清空再重绘,
 * 响应刚回来时读到的可能是空列表或上一个区服的旧值。
 *
 * ⚠️ **接口判为「无报价」(0) 的通货, 页面上本来就只有占位符**——那是渲染完成的正确形态,
 * 不是"没渲染"。把这种形态当成未渲染, 表现是**整个游戏本轮作废**: 流放之路1 的「专家」
 * 区服接口对所有通货都给 0、页面如实显示占位符, 却因为"要求页面上有数字"而永远等不到
 * 匹配, 采样 5 秒后抛错 (实测于 2026-09-18)。
 *
 * ⚠️ 判据本身仍是**严格**的, 不是"对不上就放行": 接口给了正价的通货必须读到相同的正价。
 * 接口给 0 时只要求该行存在且是占位符——上一个区服的旧值只要是正价, 照样会被识破。
 *
 * @param rows 当前 DOM 读到的行
 * @param expected 接口给出的「通货名 → 价格」
 * @param currencyList 配置的通货清单。**只有接口真的给了价的才参与比对**——接口没给的不比,
 *   否则永远对不上
 */
export function hasRenderedExpected(
    rows: RawCurrencyRow[],
    expected: ReadonlyMap<string, number>,
    currencyList: string[],
): boolean {
    return currencyList
        .filter((name) => expected.has(name))
        .every((name) => matchesRow(rows.find((item) => item.name === name), expected.get(name)));
}

/** 单独一行的比对。见 `hasRenderedExpected` 的两条语义说明 */
function matchesRow(row: RawCurrencyRow | undefined, expectedPrice: number | undefined): boolean {
    // 行本身还没出现 —— 这个通货还没渲染出来
    if (!row) return false;

    // 页面显示占位符: 与接口的「无报价」一致; 接口给了正价却读到占位符 = 还没渲染完
    if (row.priceText === null) return !(typeof expectedPrice === 'number' && expectedPrice > 0);

    // 走 `parsePriceText` 而不是 `Number.parseFloat`: 千分位会被 parseFloat 截断成错值
    // (`1,234.5` → 1), 判据与产出数据的解析必须是同一套规则, 否则比对会无声地不通过
    const price = parsePriceText(row.priceText);

    return price !== null && typeof expectedPrice === 'number' && isPriceEqual(price, expectedPrice);
}

/** 合法千分位: 分组必须是 1~3 位开头, 其后每组恰好 3 位 */
const THOUSANDS_PATTERN = /^\d{1,3}(,\d{3})+(\.\d+)?$/;

/** 合法纯十进制字面量。**不含**符号、指数、百分号、货币符号 */
const DECIMAL_PATTERN = /^\d+(\.\d+)?$/;

/**
 * 剥离千分位分隔符。
 *
 * ⚠️ **只剥离符合千分位分组的逗号**, 不做无差别的 `replace(/,/g, '')`。无差别剥离会
 * 把 `"1,23"` 这种我们其实看不懂的文本"修好"成 123——那不是解析, 是编造。
 *
 * @returns 剥好的纯数字文本; 不符合任何一种合法形态时返回 `null`
 */
function stripThousands(text: string): string | null {
    if (THOUSANDS_PATTERN.test(text)) return text.replace(/,/g, '');
    if (DECIMAL_PATTERN.test(text)) return text;

    return null;
}

/** 规范化成可比对的形态: 去掉前导零与小数部分的尾随零 */
function canonicalize(text: string): string {
    const [integer = '', fraction] = text.split('.');

    const leadingTrimmed = integer.replace(/^0+(?=\d)/, '');
    if (fraction === undefined) return leadingTrimmed;

    return `${leadingTrimmed}.${fraction.replace(/0+$/, '')}`.replace(/\.$/, '');
}
