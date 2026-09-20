// @vitest-environment happy-dom
/**
 * `readListingEntries` —— 从详情面板读挂单卡片
 *
 * 这个函数**在浏览器上下文里执行**，所以依赖全局 `document` 与 `innerText`。
 *
 * ⚠️ **详情面板与列表页是两套不同的组件**，类名不通用。这份测试的价值就在这里：
 * 挂单的价格区容器（`flex flex-col gap-2px items-end`）与列表页的
 * （`flex flex-col items-end justify-center h-40px shrink-0`）**完全不是同一个类名**。
 * 抄错了会让挂单一条都产不出来，而整个过程不报错——正是本项目最怕的静默失败。
 *
 * HTML 照**真实站点的结构**裁剪（见抓取源项目的一次性脚本与实测 DOM）。
 */

import { beforeEach, describe, expect, it } from 'vitest';
import {
    DETAIL_SELECTORS,
    readListingEntries,
} from '../../../src/services/scraper/parse';

/**
 * 造一条挂单卡片。结构照实测 DOM：
 * - 数字区（库存 / 起售）在价格区**之外**
 * - 价格区是 `flex flex-col gap-2px items-end`，其下两行相反方向
 * - 每个数字各带一个 `font-num`（比率单价也有）
 */
function cardHtml(
    stock: number,
    minBuy: number,
    perYuan: string,
    rmb: string,
): string {
    return (
        `<div class="item-wrp flex items-center justify-between py-12px w-full hover:bg-bg-1 rd-8px px-8px transition-colors">` +
        // 卖家信息
        `<div class="flex items-center gap-12px w-240px shrink-0">` +
        `<div class="relative shrink-0 size-48px"><span class="n-avatar"></span></div>` +
        `<div class="flex flex-col gap-4px flex-1 min-w-0">` +
        `<span class="text-h5 c-text-1 otext">卖家甲</span>` +
        `<span class="text-b5 c-text-1 otext">平均 3分钟发货</span>` +
        `</div></div>` +
        // 交易方式
        `<div class="flex flex-col gap-6px w-286px shrink-0 items-start pt-2px">` +
        `<div class="n-tag"><span class="n-tag__content">国服/闪回赛季/普通 支持所有方式交易</span></div>` +
        `</div>` +
        // 库存 / 起售
        `<div class="flex flex-col gap-4px text-b5 c-text-1 w-180px shrink-0">` +
        `<div class="flex items-center gap-4px"><span>库存</span><span class="font-num">${stock}</span><span>个</span></div>` +
        `<div class="text-b5 c-text-1 flex gap-4px"><span>起售</span><span class="font-num">${minBuy}</span><span>个</span></div>` +
        `</div>` +
        // 价格区
        `<div class="flex items-center gap-16px w-186px shrink-0 justify-end">` +
        `<div class="flex flex-col gap-2px items-end">` +
        `<div class="flex items-center gap-2px c-trade-text c-trade-text-c font-num text-h3 whitespace-nowrap">` +
        `<span class="text-h3">1</span><span class="text-h5">元</span><span class="text-h3">=</span>` +
        `<span class="text-h3">${perYuan}</span><span class="text-h5">个</span></div>` +
        `<div class="flex items-center gap-2px c-text-2 text-12px whitespace-nowrap">` +
        `<span class="font-num text-h4">1</span><span class="text-h6">个</span>` +
        `<span class="font-num text-h4">=</span><span class="font-num text-h4">${rmb}</span>` +
        `<span class="text-h6">元</span></div>` +
        `</div>` +
        `<button class="n-button"><span class="n-button__content">购买</span></button>` +
        `</div>` +
        `</div>`
    );
}

function render(cards: string[]): void {
    document.body.innerHTML = `<div class="flex flex-col gap-12px">${cards.join('')}</div>`;
}

beforeEach(() => {
    document.body.innerHTML = '';
});

describe('readListingEntries — 采集挂单卡片的原始文本', () => {
    it('两行都搬走，且**库存量不被价格区的数字污染**', () => {
        render([cardHtml(382, 382, '7.413', '0.1349')]);

        const rows = readListingEntries(DETAIL_SELECTORS);

        expect(rows).toHaveLength(1);
        // 只有库存与起售两个数；价格区的 1 / 7.413 / 0.1349 都不能算进来
        expect(rows[0]?.nums).toEqual(['382', '382']);
        // 第一行是比率方向（`1 元 = 7.413 个`），第二行是元价
        expect(rows[0]?.ratioSpans).toEqual([
            '1',
            '元',
            '=',
            '7.413',
            '个',
        ]);
        expect(rows[0]?.rmbSpans).toEqual([
            '1',
            '个',
            '=',
            '0.1349',
            '元',
        ]);
    });

    it('站点去掉 `item-wrp` 类名时退到列表的直接子元素', () => {
        render(
            [
                cardHtml(1, 1, '2', '0.5'),
                cardHtml(2, 1, '3', '0.33'),
            ].map((html) =>
                html.replace(/item-wrp/g, 'card-renamed'),
            ),
        );

        expect(readListingEntries(DETAIL_SELECTORS)).toHaveLength(2);
    });

    it('**价格区选择器写错时两行价格都是空**——这就是静默失败的现场', () => {
        // 模拟"照抄了列表页的价格区类名"这个错误：把 gap-2px 换成列表页那串。
        // 这正是真机上"详情一条都取不到、却没有任何报错"的原因
        render([
            cardHtml(382, 382, '7.413', '0.1349').replace(
                'flex flex-col gap-2px items-end',
                'flex flex-col items-end justify-center h-40px shrink-0',
            ),
        ]);

        const rows = readListingEntries(DETAIL_SELECTORS);

        expect(rows).toHaveLength(1);
        // 拿不到价格行 → `parseListingRows` 会把整条挂单丢弃（它要求价格解析成功）
        expect(rows[0]?.ratioSpans).toEqual([]);
        expect(rows[0]?.rmbSpans).toEqual([]);
        // ⚠️ 而且 `nums` 会被污染：价格区没认出来, "排除价格区内的数字"这一步就失效,
        // 价格里的 `1` 也会混进来。这正是这条链路上**任何失真都会被放大**的体现——
        // 好在下游因为"没有价格"而整条丢弃, 不会产出错值
        expect(rows[0]?.nums).toContain('382');
        expect(rows[0]?.nums.length).toBeGreaterThan(2);
    });

    it('列表容器不在页面上时返回空数组', () => {
        document.body.innerHTML = '<div>列表页</div>';

        expect(readListingEntries(DETAIL_SELECTORS)).toEqual([]);
    });

    it('两行都缺失（只有一行报价）时第二组为空，不互相补位', () => {
        const oneLine = cardHtml(10, 10, '5', '0.2').replace(
            /<div class="flex items-center gap-2px c-text-2 text-12px whitespace-nowrap">.*?<\/div><\/div>/,
            '</div>',
        );
        render([oneLine]);

        const rows = readListingEntries(DETAIL_SELECTORS);

        expect(rows[0]?.ratioSpans).toEqual([
            '1',
            '元',
            '=',
            '5',
            '个',
        ]);
        expect(rows[0]?.rmbSpans).toEqual([]);
    });
});
