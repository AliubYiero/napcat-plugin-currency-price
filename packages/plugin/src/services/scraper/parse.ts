/**
 * 抓取层纯函数
 *
 * 本模块**无副作用、不碰 DOM 全局、不碰文件**——它只做"给我一段页面文本 / 一个响应对象,
 * 我告诉你数据是什么"这一件事。抓取主流程 (`scraper/index.ts`) 负责所有 IO 与页面交互。
 *
 * 拆出来的理由是可测性 (见设计文档 §18)。抓取层里"页面点击有没有生效""渲染完没有"
 * 只能在真机上验; 而"读到的这个数字到底对不对"是纯函数问题, 必须在这里钉死——
 * 静默错值 (读到一个看似合理、实则错误的数字) 是抓取层最危险的失败模式。
 *
 * 本模块管**列表页**; 详情面板（成交量 + 挂单）的纯函数在 `detail.ts`, 而它的浏览器侧
 * 采集仍在本模块——浏览器侧的东西放一起, 免得两份 `page.evaluate` 各带一半选择器。
 */

// 仅类型导入: `detail.ts` 在运行期要用本模块的 `parsePriceText`, 这里是反向的类型引用。
// 用 `import type` 后运行期没有环, 打包与单测都不受影响。
import type { CurrencyDetail } from './detail';

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
    if (canonicalize(stripped) !== canonicalize(String(value)))
        return null;

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
export function parseZoneSpecIds(
    nodes: CascadeNode[] | undefined | null,
): Map<string, string> {
    const map = new Map<string, string>();

    const walk = (
        list: CascadeNode[] | undefined,
        pathPrefix: string[],
    ): void => {
        for (const node of list ?? []) {
            const currentPath = [
                ...pathPrefix,
                node.dataValueLabel ?? '',
            ];
            // 中间层级没有标识, 只有叶子有——用真值判断即可, 空串与 undefined 都不入映射
            if (node.dataValue)
                map.set(currentPath.join('/'), node.dataValue);
            walk(node.children, currentPath);
        }
    };

    walk(nodes ?? [], []);

    return map;
}

// ==================== 浏览器侧采集 ====================

/** 站点选择器。价格行的颜色类随价格来源变化, 因此**按位置**取容器下的 div */
export interface CurrencySelectors {
    /** 左侧通货列表容器 */
    sidebar: string;
    /** 通货名 */
    itemName: string;
    /** 价格容器（内含方向相反的两行价格） */
    itemPriceBox: string;
    /** 无价格时的占位符（容器内只有它） */
    itemEmptyPrice: string;
    /** 价格行 = 价格容器下的**直接子 div**。**恰有两行**, 分工见 `readCurrencyList` */
    itemPriceLines: string;
}

export const CURRENCY_SELECTORS: CurrencySelectors = {
    sidebar: '.flex.flex-col.overflow-y-auto.flex-1',
    itemName: '.text-h5.c-text-1.truncate',
    itemPriceBox:
        '.flex.flex-col.items-end.justify-center.h-40px.shrink-0',
    itemEmptyPrice: '.c-text-3',
    // `:scope > div` 而不是匹配颜色类: 该行颜色类随价格来源变化 (c-success-text-c /
    // c-trade-text-c / c-text-2), 照颜色类匹配会在站点换样式时静默读不到价格。
    itemPriceLines: ':scope > div',
};

/** 采集到的一行：**原始文本, 尚未解析**。见 `readCurrencyList` 的说明 */
export interface RawCurrencyRow {
    name: string;
    /** 比率价文本（**主方向**, 第二行 `1 元 = <值> <通货>` 的值位）; `null` = 无报价或形态守卫不通过 */
    ratioText: string | null;
    /** 元价文本（第一行 `1 <通货> = <值> 元` 的值位）; `null` = 读不到 */
    rmbText: string | null;
    /** 计数的通货单位, 如 `个` / `万金` / `火`。**两行互校通过时才有值** */
    countUnit: string | null;
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
 *
 * ⚠️ **两行的方向相反, 而两行的 DOM 形态完全一样**（都是 5 个 span、同样按位置取值）。
 * 读错行不会报错, 只会让两个方向对调——而两个数单看都像正常价格。所以这里**不靠顺序猜**,
 * 而是给每行验明正身:
 *
 * - 第一行 `1 <通货> = <值> 元` → `spans[1]` 是通货单位, `spans[4]` 是 `元`
 * - 第二行 `1 元 = <值> <通货>` → `spans[1]` 是 `元`, `spans[4]` 是通货单位
 *
 * 除各自的 `元` 位置外, 两行的通货单位还要**互相印证**（第一行的 `spans[1]` ===
 * 第二行的 `spans[4]`）。任何一条不满足就整行记 `null`——宁可少一条数据,
 * 不可多一条方向反了的数据。
 */
export function readCurrencyList(
    s: CurrencySelectors,
): RawCurrencyRow[] {
    /** 一行的 5 个 span 文本: `1 <基准单位> = <值> <计价单位>` */
    const spansOf = (line: Element | undefined): string[] =>
        line
            ? [...line.querySelectorAll('span')].map((el) =>
                  (el as HTMLElement).innerText.trim(),
              )
            : [];

    const sidebar = [...document.querySelectorAll(s.sidebar)].find(
        (el) => el.querySelector(s.itemName),
    );
    if (!sidebar) return [];

    return [...sidebar.children].map((item): RawCurrencyRow => {
        const nameEl = item.querySelector(s.itemName);
        const name = nameEl
            ? (nameEl as HTMLElement).innerText.trim()
            : '';
        const unreadable: RawCurrencyRow = {
            name,
            ratioText: null,
            rmbText: null,
            countUnit: null,
        };

        // 无报价时容器内只有占位符, 根本没有价格行
        const priceBox = item.querySelector(s.itemPriceBox);
        if (!priceBox || priceBox.querySelector(s.itemEmptyPrice))
            return unreadable;

        const lines = priceBox.querySelectorAll(s.itemPriceLines);
        const rmbSpans = spansOf(lines[0]);
        const ratioSpans = spansOf(lines[1]);

        if (rmbSpans[4] !== '元' || ratioSpans[1] !== '元')
            return unreadable;
        if (!rmbSpans[1] || rmbSpans[1] !== ratioSpans[4])
            return unreadable;

        return {
            name,
            ratioText: ratioSpans[3] ?? null,
            rmbText: rmbSpans[3] ?? null,
            countUnit: ratioSpans[4] ?? null,
        };
    });
}

// ==================== Node 侧解析 ====================

/** 一条价格记录，与 `data.json` 的 `zones[].prices[]` 同构 */
export interface PriceItem {
    name: string;
    /**
     * 比率价 = 1 元能买几个（**主方向**, 单位形如 `个/元`）。
     * **`null` = 本次未取到**。
     *
     * ⚠️ **不再是"数字或 0"**: 站点上没有"确实报 0"这个形态——接口的 `ratioPrice` 为 `0`
     * 表示本区服无报价, 页面显示的也本来就是占位符, 两者是同一件事。保留一个永不出现的
     * `0`, 只会让下游继续写 `price ?? 0` 这类把两者混起来的代码（ADR-0006 结论 4）。
     */
    price: number | null;
    /** 如 `个/元`; 未取到时为 `null` */
    unit: string | null;
    /**
     * 元价 = 每个多少元（单位形如 `元/个`）。
     *
     * ⚠️ **取自接口的 `rmbPrice` 字段 / 页面第一行的显示值, 不是 `1 / price` 算出来的**——
     * 两个方向是**两个独立的事实**, 不是精确倒数（ADR-0005 结论 2）。
     * 与 `rmbUnit` **同进同出**, 读不到时两个键一起不出现。
     */
    rmbPrice?: number;
    /** 形如 `元/个`。与 `rmbPrice` 同进同出 */
    rmbUnit?: string;
    /**
     * 市价失真：挂单深度不足以构成一个价格市场。**只在失真时出现**（键缺失即正常）。
     *
     * ⚠️ 它**推导不出来**, 所以必须显式记：失真时 `price` 为 `null`, 而"配了详情但没取到"
     * 也是 `null`; 更糟的是挂单列表为空时 `detail` 也为 `null`——那正是最该判失真的情形
     * （0 条 < 15）。见 ADR-0007 结论 3。
     */
    thinMarket?: true;
    /**
     * 详情块。**三种状态不可归一**: 没开详情(键不出现) / 开了但没取到(`null`) / 取到了(对象)。
     * 归一会让"为什么这份数据没有详情"变成无法回答的问题（ADR-0005 结论 6）。
     */
    detail?: CurrencyDetail | null;
}

/**
 * 把采集到的原始行解析成价格记录。
 *
 * 单位由页面的两行各自拼出（`个/元` 与 `元/个`）。价格走 `parsePriceText`, 因此千分位与
 * 精度问题在这里被统一挡住; 挡下时**整条记 `null`**——宁可少一条数据, 不可多一条错数据。
 *
 * ⚠️ 元方向是**独立的第二个字段**, 不是算出来的; 但它与主方向**同生共死**:
 * 主方向读不出来时整条记 `null`（不产出半个价格）。
 */
export function parseCurrencyRow(row: RawCurrencyRow): PriceItem {
    const price =
        row.ratioText === null ? null : parsePriceText(row.ratioText);

    // 0 不是有效报价——站点上它表示"无报价", 与"未取到"是同一件事（见 `PriceItem.price`）
    if (price === null || price <= 0)
        return { name: row.name, price: null, unit: null };

    const entry: PriceItem = {
        name: row.name,
        price,
        unit: row.countUnit ? `${row.countUnit}/元` : null,
    };

    const rmbPrice =
        row.rmbText === null ? null : parsePriceText(row.rmbText);
    if (rmbPrice !== null && row.countUnit) {
        entry.rmbPrice = rmbPrice;
        entry.rmbUnit = `元/${row.countUnit}`;
    }

    return entry;
}

// ==================== 渲染完成判定 ====================

/** 两个价格是否一致。容忍前端可能的浮点格式化差异 (`1.23` ≡ `1.2300`), 但不容忍数量级偏差 */
function isPriceEqual(a: number, b: number): boolean {
    return Math.abs(a - b) <= Math.max(1e-9, Math.abs(b) * 1e-6);
}

/**
 * 判断 DOM 读到的行是否**已经渲染出接口返回的价格**。
 *
 * ⚠️ **它不再是价格的正确性防线**（价格由接口定, 见 ADR-0006 结论 1）。现在的唯一职责是
 * **「DOM 刷新了没有」**：切换区服时列表会先清空再重绘, 响应刚回来时读到的可能是空列表或
 * 上一个区服的旧值。因此**只在需要走 DOM 兜底时**才调用它——主路径根本不读 DOM。
 *
 * ⚠️ **两个方向必须同向比对**：DOM 读的是第二行（比率价）, 所以期望值也必须是接口的
 * `ratioPrice`。拿元价（`rmbPrice`）来比是两个方向的比对, 元方向那 4 位小数的舍入会让它
 * 对不上——这正是改造前那处错误的比对。
 *
 * ⚠️ 它判错**不再能让整轮作废**：等不到就退回"这些通货记 `null`"。改造前它是价格的防线,
 * 判错的代价是整个游戏本轮作废（实测踩过: 流放之路1 的「专家」区服接口对所有通货都给 0、
 * 页面如实显示占位符, 却因为"要求页面上有数字"而永远等不到匹配, 采样 5 秒后抛错）。
 *
 * ⚠️ 判据本身仍是**严格**的, 不是"对不上就放行": 接口给了正价的通货必须读到相同的正价。
 * 接口判为「无报价」的通货, 页面上本来就只有占位符——那是渲染完成的正确形态。
 * 上一个区服的旧值只要是正价, 照样会被识破。
 *
 * @param rows 当前 DOM 读到的行
 * @param expected 接口给出的「通货名 → **比率价**」
 * @param currencyNames 配置的通货名。**只有接口真的给了价的才参与比对**——接口没给的不比,
 *   否则永远对不上
 */
export function hasRenderedExpected(
    rows: RawCurrencyRow[],
    expected: ReadonlyMap<string, number>,
    currencyNames: string[],
): boolean {
    return currencyNames
        .filter((name) => expected.has(name))
        .every((name) =>
            matchesRow(
                rows.find((item) => item.name === name),
                expected.get(name),
            ),
        );
}

/** 单独一行的比对。见 `hasRenderedExpected` 的两条语义说明 */
function matchesRow(
    row: RawCurrencyRow | undefined,
    expectedPrice: number | undefined,
): boolean {
    // 行本身还没出现 —— 这个通货还没渲染出来
    if (!row) return false;

    // 读到占位符, 或形态守卫没通过: 与接口的「无报价」一致;
    // 接口给了正价却读不到价格 = 还没渲染完（或站点改版了, 那条路会一路记 null）
    if (row.ratioText === null) {
        return !(
            typeof expectedPrice === 'number' && expectedPrice > 0
        );
    }

    // 走 `parsePriceText` 而不是 `Number.parseFloat`: 千分位会被 parseFloat 截断成错值
    // (`1,234.5` → 1), 判据与产出数据的解析必须是同一套规则, 否则比对会无声地不通过
    const price = parsePriceText(row.ratioText);

    return (
        price !== null &&
        typeof expectedPrice === 'number' &&
        isPriceEqual(price, expectedPrice)
    );
}

// ==================== 详情面板的浏览器侧采集 ====================

/**
 * 详情面板的选择器。
 *
 * ⚠️ **与列表页不是同一套组件, 类名不通用**。挂单卡片的价格区是
 * `flex flex-col gap-2px items-end`, 而列表页的是
 * `flex flex-col items-end justify-center h-40px shrink-0`。照抄列表页那串会让挂单
 * **一条都产不出来且不报错**——实测踩过这个坑（ADR-0005 结论 2 的那次复盘）。
 */
export interface DetailSelectors {
    /** 面板头部的通货名。用来确认"当前面板是目标通货" */
    currencyName: string;
    /** 成交量所在行 */
    volumeRow: string;
    /** 成交量行里的数字（原文, 形如 `518.3w`） */
    volumeValue: string;
    /** 挂单列表容器。**按它取直接子元素当卡片**, 不按卡片类名过滤——类名是站点最先变的东西 */
    list: string;
    /** 卡片类名。**只作定位提示, 不作过滤条件**: 站点去掉它时上面的容器仍然可用 */
    listItem: string;
    /** 卡片里**价格区之外**的数字, 按位置依次是库存、起售。价格区本身也全是这个类, 要排除 */
    rowNums: string;
    /** 卡片价格区 = 卡片下的那个 div */
    cardPriceBox: string;
    /** 卡片价格行 = 价格区下的直接子 div。**恰有两行** */
    cardPriceLines: string;
}

export const DETAIL_SELECTORS: DetailSelectors = {
    currencyName: 'h2.flex-1.text-h3.c-text-1.otext',
    volumeRow: '.flex.items-center.gap-4px.text-b6',
    volumeValue: '.font-num.c-text-1',
    list: '.flex.flex-col.gap-12px',
    listItem: 'item-wrp',
    rowNums: '.font-num',
    // ⚠️ 与列表页的 `itemPriceBox` **不是同一个类名**, 见本接口的说明
    cardPriceBox: '.flex.flex-col.gap-2px.items-end',
    cardPriceLines: ':scope > div',
};

/** 详情面板里一张挂单卡片的**原始文本**（全是未解析的, 解析在 `detail.ts`） */
export interface RawListingRow {
    /** 卡片里价格区之外的数字文本, 按位置依次是 库存、起售 */
    nums: string[];
    /**
     * 价格区**第一行**的 5 个 span 文本。
     *
     * ⚠️ 实测这一行是 `1 元 = 8.4746 个`——值是**比率方向（`个/元`）**, 与列表页相反
     * （列表页第一行是 `1 <通货> = <值> 元`）。方向由 `parseListingRows` 负责, 这里只搬文本。
     */
    ratioSpans: string[];
    /** 价格区**第二行**的 5 个 span 文本（`1 <通货> = <值> 元`, 元方向）。该行缺失时为空数组 */
    rmbSpans: string[];
}

/**
 * 从详情面板读挂单卡片。
 *
 * ⚠️ **本函数在浏览器上下文执行, 必须自包含**（同 `readCurrencyList`）。
 *
 * ⚠️ 价格区的定位**按位置**（卡片下的 div）而不是类名——类名是站点最先变的东西。
 * 但价格区若定位失败, `nums` 会被价格里的数字污染: "排除价格区内的数字"这一步本身就失效了。
 * 好在下游 `parseListingRows` 会因为没有价格而整条丢弃, 不会产出错值——这是这条链路上
 * 「任何失真都会被放大」的体现, 也是那些测试用例存在的理由。
 */
export function readListingEntries(
    s: DetailSelectors,
): RawListingRow[] {
    const spansOf = (line: Element | undefined): string[] =>
        line
            ? [...line.querySelectorAll('span')].map((el) =>
                  (el as HTMLElement).innerText.trim(),
              )
            : [];

    // 容器优先按列表类名找; 找不到时退到"任一张卡片的父元素"
    const list =
        document.querySelector(s.list) ??
        document.querySelector(`.${s.listItem}`)?.parentElement ??
        null;
    if (!list) return [];

    return [...list.children].map((card): RawListingRow => {
        // ⚠️ 是 `priceBox.querySelectorAll` 而**不是** `card.querySelectorAll`:
        // `:scope` 指的是调用它的那个元素。写成 card 的话取到的是卡片的直接子元素
        // （卖家信息、交易方式……），价格行一条都读不到, 而整个过程不报错
        const priceBox = card.querySelector(s.cardPriceBox);
        const lines = priceBox
            ? priceBox.querySelectorAll(s.cardPriceLines)
            : [];

        // ⚠️ 价格区没认出来时这里**不做任何补救**（不猜类名、不换选择器）:
        // 补救会把价格里的数字留进 `nums`, 而下游据此算出的库存会是个错值
        const nums = [...card.querySelectorAll(s.rowNums)]
            .filter((el) => !priceBox || !priceBox.contains(el))
            .map((el) => (el as HTMLElement).innerText.trim())
            .filter((text) => text.length > 0);

        return {
            nums,
            ratioSpans: spansOf(lines[0]),
            rmbSpans: spansOf(lines[1]),
        };
    });
}

/**
 * 按位置读面板头部的通货名与成交量原文。
 *
 * 成交量**只有 DOM 有**——详情接口不给这个字段。返回空串是合法结果（"详情取到了但成交量
 * 没读到"）, 与"没取到详情"是两件事。
 */
export function readDetailPanel(s: DetailSelectors): {
    name: string;
    volumeText: string;
} {
    const nameEl = document.querySelector(s.currencyName);
    const numberEl = document
        .querySelector(s.volumeRow)
        ?.querySelector(s.volumeValue);

    return {
        name: nameEl ? (nameEl as HTMLElement).innerText.trim() : '',
        volumeText: numberEl
            ? (numberEl as HTMLElement).innerText.trim()
            : '',
    };
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

    return `${leadingTrimmed}.${fraction.replace(/0+$/, '')}`.replace(
        /\.$/,
        '',
    );
}
