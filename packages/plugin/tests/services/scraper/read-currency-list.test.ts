// @vitest-environment happy-dom
/**
 * `readCurrencyList` —— 从左侧列表读出通货名与价格
 *
 * 这个函数**在浏览器上下文里执行**（`page.evaluate(readCurrencyList, SELECTORS)`），
 * 所以它依赖全局 `document` 与 `innerText`。测试用 happy-dom 喂固定 HTML——
 * jsdom 至今没实现 `innerText`，而这里的选择器逻辑恰恰靠它。
 *
 * 固定的 HTML 片段照**真实站点的结构**裁剪而成（见抓取源项目 `src/index.js` 的 SELECTORS）：
 * 价格行是 `1 <基准单位> = <价格> <计价单位>`，且容器内还有第二行反向价，
 * 后者**必须不被读到**。
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { CURRENCY_SELECTORS, readCurrencyList } from '../../../src/services/scraper/parse';

/** 造一条通货行的 HTML。`priceLine` 为空串表示该通货无报价（页面显示占位符） */
function itemHtml(name: string, priceLine = ''): string {
    const priceBox = priceLine
        ? `<div class="${PRICE_BOX_CLASS}">${priceLine}<div class="reverse">1 元 = 4.09 个</div></div>`
        : `<div class="${PRICE_BOX_CLASS}"><div class="c-text-3">--</div></div>`;

    return `<div class="item">${nameHtml(name)}${priceBox}</div>`;
}

const NAME_CLASS = 'text-h5 c-text-1 truncate';
const PRICE_BOX_CLASS = 'flex flex-col items-end justify-center h-40px shrink-0';

function nameHtml(name: string): string {
    return `<div class="${NAME_CLASS}">${name}</div>`;
}

/** 价格行：`1 <基准单位> = <价格> <计价单位>` */
function priceLine(base: string, value: string, quote: string): string {
    return `<div><span>1</span><span>${base}</span><span>=</span><span>${value}</span><span>${quote}</span></div>`;
}

function render(items: string[]): void {
    document.body.innerHTML = `<div class="flex flex-col overflow-y-auto flex-1">${items.join('')}</div>`;
}

beforeEach(() => {
    document.body.innerHTML = '';
});

describe('readCurrencyList — 采集通货行的原始文本', () => {
    it('读出通货名与价格行的三段文本（价格与单位**不在浏览器侧解析**）', () => {
        render([itemHtml('神圣石', priceLine('个', '0.2444', '元'))]);

        expect(readCurrencyList(CURRENCY_SELECTORS)).toEqual([
            { name: '神圣石', priceText: '0.2444', baseUnit: '个', quoteUnit: '元' },
        ]);
    });

    it('无报价的行（容器内只有占位符）三段文本全为 null', () => {
        render([itemHtml('崇高石')]);

        expect(readCurrencyList(CURRENCY_SELECTORS)).toEqual([
            { name: '崇高石', priceText: null, baseUnit: null, quoteUnit: null },
        ]);
    });

    it('**只取价格行的第一行**: 容器内的第二行反向价不被读到', () => {
        render([itemHtml('神圣石', priceLine('个', '0.2444', '元'))]);

        // 第二行是 `1 元 = 4.09 个`。读错行会得到 4.09, 或把第一行的 `1` 当成价格
        expect(readCurrencyList(CURRENCY_SELECTORS)[0]?.priceText).toBe('0.2444');
    });

    it('千分位价格文本**原样搬运**, 解析留给 Node 侧（不在浏览器里抄一份解析逻辑）', () => {
        render([itemHtml('神圣石', priceLine('个', '1,234.5', '元'))]);

        expect(readCurrencyList(CURRENCY_SELECTORS)[0]?.priceText).toBe('1,234.5');
    });

    it('同类容器有多个时, 取**含通货名**的那个', () => {
        document.body.innerHTML = `
            <div class="flex flex-col overflow-y-auto flex-1"><div>一个空侧栏</div></div>
            <div class="flex flex-col overflow-y-auto flex-1">${itemHtml('神圣石', priceLine('个', '0.2444', '元'))}</div>`;

        expect(readCurrencyList(CURRENCY_SELECTORS)).toHaveLength(1);
    });

    it('找不到通货列表时返回空数组（被拦截的空壳页面就是这种形态）', () => {
        document.body.innerHTML = '<div>验证码</div>';

        expect(readCurrencyList(CURRENCY_SELECTORS)).toEqual([]);
    });
});
