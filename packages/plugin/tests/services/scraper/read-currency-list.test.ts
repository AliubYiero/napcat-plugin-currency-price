// @vitest-environment happy-dom
/**
 * `readCurrencyList` —— 从左侧列表读出通货行两行的原始文本
 *
 * 这个函数**在浏览器上下文里执行**（`page.evaluate(readCurrencyList, SELECTORS)`），
 * 所以它依赖全局 `document` 与 `innerText`。测试用 happy-dom 喂固定 HTML——
 * jsdom 至今没实现 `innerText`，而这里的选择器逻辑恰恰靠它。
 *
 * 固定的 HTML 片段照**真实站点的结构**裁剪而成。整个文件的价值集中在一件事上：
 *
 * ⚠️ **价格区的两行方向相反，而两行的 DOM 形态一模一样**（都是 5 个 span、同样按位置
 * 取值）：
 *
 * - 第一行 `1 <通货> = <值> 元` → **元价**
 * - 第二行 `1 元 = <值> <通货>` → **比率价**（主方向）
 *
 * 读错行不会抛错，只会让两个方向对调——而两个数单看都像正常价格。所以这里靠每行的
 * 第 2 个 span 分辨（第二行必须是 `元`），并让两行的通货单位**互相印证**。
 */

import { beforeEach, describe, expect, it } from 'vitest';
import {
    CURRENCY_SELECTORS,
    readCurrencyList,
} from '../../../src/services/scraper/parse';

const NAME_CLASS = 'text-h5 c-text-1 truncate';
const PRICE_BOX_CLASS =
    'flex flex-col items-end justify-center h-40px shrink-0';

function nameHtml(name: string): string {
    return `<div class="${NAME_CLASS}">${name}</div>`;
}

/** 一行的 5 个 span：`1 <基准单位> = <值> <计价单位>` */
function lineHtml(
    base: string,
    value: string,
    quote: string,
): string {
    return `<div><span>1</span><span>${base}</span><span>=</span><span>${value}</span><span>${quote}</span></div>`;
}

/**
 * 造一条通货行。
 *
 * 默认值是真实形态：`1 个 = 0.2444 元`（元价）在上, `1 元 = 4.09 个`（比率价）在下。
 * `rmb` 传 `null` 表示该通货无报价（容器里只有一个占位符）。
 */
function itemHtml(
    name: string,
    rmb: string | null = '0.2444',
    ratio = '4.09',
): string {
    const priceBox =
        rmb === null
            ? `<div class="${PRICE_BOX_CLASS}"><div class="c-text-3">--</div></div>`
            : `<div class="${PRICE_BOX_CLASS}">${lineHtml('个', rmb, '元')}${lineHtml('元', ratio, '个')}</div>`;

    return `<div class="item">${nameHtml(name)}${priceBox}</div>`;
}

function render(items: string[]): void {
    document.body.innerHTML = `<div class="flex flex-col overflow-y-auto flex-1">${items.join('')}</div>`;
}

beforeEach(() => {
    document.body.innerHTML = '';
});

describe('readCurrencyList — 采集通货行的原始文本', () => {
    it('两行都读出来，并标明计数的通货单位（价格与单位**不在浏览器侧解析**）', () => {
        render([itemHtml('神圣石')]);

        expect(readCurrencyList(CURRENCY_SELECTORS)).toEqual([
            {
                name: '神圣石',
                ratioText: '4.09',
                rmbText: '0.2444',
                countUnit: '个',
            },
        ]);
    });

    it('**主方向取的是第二行**：读错行会拿到元价 0.2444, 而它看起来同样合理', () => {
        render([itemHtml('神圣石')]);

        expect(
            readCurrencyList(CURRENCY_SELECTORS)[0]?.ratioText,
        ).toBe('4.09');
        expect(
            readCurrencyList(CURRENCY_SELECTORS)[0]?.ratioText,
        ).not.toBe('0.2444');
    });

    it('无报价的行（容器内只有占位符）三个字段全为 null', () => {
        render([itemHtml('崇高石', null)]);

        expect(readCurrencyList(CURRENCY_SELECTORS)).toEqual([
            {
                name: '崇高石',
                ratioText: null,
                rmbText: null,
                countUnit: null,
            },
        ]);
    });

    it('**形态守卫：第二行的第 2 个 span 必须是 `元`** —— 两行顺序颠倒时整行记 null', () => {
        // 站点若把两行对调（或我们抄错了顺序），这里必须**读不出来**而不是读出一个反方向的值
        const swapped =
            `<div class="item">${nameHtml('神圣石')}<div class="${PRICE_BOX_CLASS}">` +
            `${lineHtml('元', '4.09', '个')}${lineHtml('个', '0.2444', '元')}</div></div>`;
        render([swapped]);

        expect(
            readCurrencyList(CURRENCY_SELECTORS)[0]?.ratioText,
        ).toBe(null);
    });

    it('**形态守卫：两行的通货单位必须互相印证** —— 对不上时整行记 null', () => {
        // 第一行说通货单位是 `个`、第二行说 `万金`: 两行不是同一条通货的价格
        const mismatched =
            `<div class="item">${nameHtml('神圣石')}<div class="${PRICE_BOX_CLASS}">` +
            `${lineHtml('个', '0.2444', '元')}${lineHtml('元', '4.09', '万金')}</div></div>`;
        render([mismatched]);

        expect(
            readCurrencyList(CURRENCY_SELECTORS)[0]?.countUnit,
        ).toBe(null);
    });

    it('**只有一行时读不出来**：缺了另一行就没有互校, 宁可不读', () => {
        const oneLine =
            `<div class="item">${nameHtml('神圣石')}<div class="${PRICE_BOX_CLASS}">` +
            `${lineHtml('元', '4.09', '个')}</div></div>`;
        render([oneLine]);

        expect(
            readCurrencyList(CURRENCY_SELECTORS)[0]?.ratioText,
        ).toBe(null);
    });

    it('千分位价格文本**原样搬运**, 解析留给 Node 侧（不在浏览器里抄一份解析逻辑）', () => {
        render([itemHtml('卡兰德的魔镜', '0.0008', '1,234.5')]);

        expect(
            readCurrencyList(CURRENCY_SELECTORS)[0]?.ratioText,
        ).toBe('1,234.5');
    });

    it('单位不是 `个` 时也照样读（火炬之光的 `火`、金币系列的 `万金`）', () => {
        const fire =
            `<div class="item">${nameHtml('初火源质')}<div class="${PRICE_BOX_CLASS}">` +
            `${lineHtml('火', '0.0012', '元')}${lineHtml('元', '826.182', '火')}</div></div>`;
        render([fire]);

        expect(readCurrencyList(CURRENCY_SELECTORS)[0]).toEqual({
            name: '初火源质',
            ratioText: '826.182',
            rmbText: '0.0012',
            countUnit: '火',
        });
    });

    it('同类容器有多个时, 取**含通货名**的那个', () => {
        document.body.innerHTML = `
            <div class="flex flex-col overflow-y-auto flex-1"><div>一个空侧栏</div></div>
            <div class="flex flex-col overflow-y-auto flex-1">${itemHtml('神圣石')}</div>`;

        expect(readCurrencyList(CURRENCY_SELECTORS)).toHaveLength(1);
    });

    it('找不到通货列表时返回空数组（被拦截的空壳页面就是这种形态）', () => {
        document.body.innerHTML = '<div>验证码</div>';

        expect(readCurrencyList(CURRENCY_SELECTORS)).toEqual([]);
    });
});
