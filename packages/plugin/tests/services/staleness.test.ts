/**
 * 新鲜度判定（片 05, §9.2）
 *
 * 两个依据: 时间（恰好 5 分钟算**新鲜**, 严格大于才算过期; 从未抓取判过期）与
 * **配置指纹**（数据不是按当前这份配置抓的 → 过期, 与时间无关）。
 */

import { describe, expect, it } from 'vitest';
import {
    STALENESS_THRESHOLD_MS,
    configFingerprintOf,
    getStaleGames,
    isStaleGame,
} from '../../src/services/staleness';
import type { GameRecord } from '../../src/store/data.store';
import type { CatalogConfig } from '../../src/types';

const NOW = 1_789_000_000_000;

function catalog(overrides: Partial<CatalogConfig> = {}): CatalogConfig {
    return {
        name: '流放之路2',
        pageUrl: 'https://qiandao.com/currency/currency-zone?catalogName=流放2专区',
        currencyList: ['神圣石'],
        zoneConfigs: [['国服', '赛季', '普通']],
        ...overrides,
    };
}

function record(minuteAge: number, fingerprint = configFingerprintOf(catalog())): GameRecord {
    return {
        readAt: new Date(NOW - minuteAge * 60_000).toISOString(),
        zones: [],
        missing: [],
        configFingerprint: fingerprint,
        lastError: null,
    };
}

describe('isStaleGame', () => {
    it('超过 5 分钟 → 过期', () => {
        expect(isStaleGame(record(6).readAt, { now: () => NOW })).toBe(true);
    });

    it('**边界恰好 5 分钟 → 新鲜**（判定条件是严格大于）', () => {
        expect(isStaleGame(record(5).readAt, { now: () => NOW })).toBe(false);
    });

    it('5 分钟以内 → 新鲜', () => {
        expect(isStaleGame(record(2).readAt, { now: () => NOW })).toBe(false);
    });

    it('**从未抓到过（readAt 不存在）→ 过期**', () => {
        expect(isStaleGame(null, { now: () => NOW })).toBe(true);
        expect(isStaleGame(undefined, { now: () => NOW })).toBe(true);
        expect(isStaleGame('', { now: () => NOW })).toBe(true);
    });

    it('readAt 无法解析 → 过期（宁可多抓, 不可当新的用）', () => {
        expect(isStaleGame('not-a-date', { now: () => NOW })).toBe(true);
    });

    it('阈值常量是 5 分钟, 且**不是配置项**', () => {
        expect(STALENESS_THRESHOLD_MS).toBe(5 * 60 * 1000);
    });
});

describe('configFingerprintOf', () => {
    it('**决定抓到什么的三个字段**变一个, 指纹就变', () => {
        const base = configFingerprintOf(catalog());

        expect(configFingerprintOf(catalog({ pageUrl: 'https://qiandao.com/别的页面' }))).not.toBe(base);
        expect(configFingerprintOf(catalog({ currencyList: ['崇高石'] }))).not.toBe(base);
        expect(configFingerprintOf(catalog({ zoneConfigs: [['国际服', '赛季', '普通']] }))).not.toBe(base);
    });

    it('组合的**顺序**算数——它就是消息里区服的呈现顺序', () => {
        const twoZones = [['国服'], ['国际服']];

        expect(configFingerprintOf(catalog({ zoneConfigs: twoZones })))
            .not.toBe(configFingerprintOf(catalog({ zoneConfigs: [...twoZones].reverse() })));
    });

    it('`name` 不进指纹——名字是记录的键, 改名相当于换了个游戏（由"无记录"覆盖）', () => {
        expect(configFingerprintOf(catalog({ name: '流放之路1' })))
            .toBe(configFingerprintOf(catalog()));
    });
});

describe('getStaleGames', () => {
    /** 记录表: 游戏名 → 记录。指纹按"这份数据是用传进来的这份配置抓的"构造 */
    function depsWith(records: Record<string, GameRecord | null>) {
        return { now: () => NOW, getGame: (name: string) => records[name] ?? null };
    }

    it('只筛出过期的; 全部新鲜时返回空（→ 完全不启动浏览器）', () => {
        const target = catalog({ name: 'freshGame' });

        expect(
            getStaleGames([target], depsWith({ freshGame: record(2, configFingerprintOf(target)) })),
        ).toEqual([]);
    });

    it('部分过期 → 只返回过期的那些', () => {
        const fresh = catalog({ name: 'freshGame' });
        const stale = catalog({ name: 'staleGame' });

        expect(getStaleGames(
            [fresh, stale],
            depsWith({
                freshGame: record(2, configFingerprintOf(fresh)),
                staleGame: record(15, configFingerprintOf(stale)),
            }),
        )).toEqual(['staleGame']);
    });

    it('从未抓到的游戏判过期', () => {
        expect(getStaleGames([catalog({ name: 'neverGame' })], depsWith({}))).toEqual(['neverGame']);
    });

    it('**配置改过 → 过期**, 哪怕数据是一分钟前刚抓的', () => {
        const target = catalog({ zoneConfigs: [['国服', '赛季', '专家']] });

        // 记录是**旧配置**（不同组合）抓的
        expect(
            getStaleGames([target], depsWith({ 流放之路2: record(1) })),
        ).toEqual(['流放之路2']);
    });

    it('**旧文件（没有指纹字段）判过期**——空指纹与任何真实配置都对不上', () => {
        const target = catalog();

        expect(
            getStaleGames([target], depsWith({ 流放之路2: record(1, '') })),
        ).toEqual(['流放之路2']);
    });

    it('保持传入顺序输出——抓取顺序是展示顺序的依据', () => {
        expect(getStaleGames(
            [catalog({ name: 'neverGame' }), catalog({ name: 'staleGame' })],
            depsWith({ staleGame: record(15, configFingerprintOf(catalog({ name: 'staleGame' }))) }),
        )).toEqual(['neverGame', 'staleGame']);
    });
});
