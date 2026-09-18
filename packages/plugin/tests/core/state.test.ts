import { describe, expect, it } from 'vitest';
import { sanitizeConfig } from '../../src/core/state';
import { DEFAULT_CONFIG } from '../../src/config';

describe('DEFAULT_CONFIG — 默认值契约', () => {
    it('不再包含 cooldownSeconds（指令冷却的语义已被数据新鲜度阈值取代）', () => {
        expect(Object.keys(DEFAULT_CONFIG)).not.toContain('cooldownSeconds');
    });

    it('指令前缀缺省 #currency', () => {
        expect(DEFAULT_CONFIG.commandPrefix).toBe('#currency');
    });

    it('零配置可用：插件总开关默认开、群开关默认开、@机器人触发默认开、通知默认关', () => {
        expect(DEFAULT_CONFIG.enabled).toBe(true);
        expect(DEFAULT_CONFIG.allowAtBotTrigger).toBe(true);
        expect(DEFAULT_CONFIG.groupConfigs).toEqual({});
        // notifyEnabled 是会话级字段, 默认关闭——见 CONTEXT.md 的"默认值语义声明"
        expect(DEFAULT_CONFIG.pushIntervalMs).toBe(100);
    });

    it('默认 catalogs 是三分区清单, 合计 10 个区服组合', () => {
        const zoneCount = DEFAULT_CONFIG.catalogs.reduce(
            (sum, catalog) => sum + catalog.zoneConfigs.length,
            0,
        );

        expect(DEFAULT_CONFIG.catalogs.map((c) => c.name)).toEqual([
            '流放之路2',
            '流放之路1',
            '火炬之光',
        ]);
        expect(zoneCount).toBe(6);
    });
});

describe('sanitizeConfig — pushHours（枚举数组）', () => {
    it('过滤掉非法值，只保留 0~23 的整数', () => {
        const out = sanitizeConfig({
            pushHours: [0, 8, 23, -1, 24, 3.5, '8', null, true],
        });

        expect(out.pushHours).toEqual([0, 8, 23]);
    });

    it('空数组是合法语义 (不做定时推送), 保持为空而不回退默认', () => {
        const out = sanitizeConfig({ pushHours: [] });

        expect(out.pushHours).toEqual([]);
    });

    it('字段缺失或类型不对时才回退默认 (全选 0~23)', () => {
        // 期望值是设计文档 §5.1 写死的「默认全选」, 不从 DEFAULT_CONFIG 读——否则是同义反复
        const everyHour = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23];

        expect(sanitizeConfig({ pushHours: 'abc' }).pushHours).toEqual(everyHour);
        expect(sanitizeConfig({}).pushHours).toEqual(everyHour);
    });
});

describe('sanitizeConfig — catalogs（嵌套对象数组）', () => {
    const validCatalog = {
        name: '流放之路2',
        pageUrl: 'https://qiandao.com/currency/currency-zone?islandId=301000',
        currencyList: ['神圣石'],
        zoneConfigs: [['国服', '赛季', '普通']],
    };

    it('整体不合法的条目被丢弃，合法条目原样保留', () => {
        const out = sanitizeConfig({
            catalogs: [
                'not-an-object',
                { pageUrl: 'https://a' }, // 缺 name
                { name: '  ', pageUrl: 'https://b' }, // name 是空白
                { name: '缺页面', pageUrl: 42 }, // pageUrl 类型不对
                validCatalog,
            ],
        });

        expect(out.catalogs).toEqual([validCatalog]);
    });

    it('zoneConfigs 逐行递归清洗：非字符串元素的行被丢弃，合法行保留', () => {
        const out = sanitizeConfig({
            catalogs: [
                {
                    ...validCatalog,
                    zoneConfigs: [
                        ['国服', '赛季', '普通'],
                        'not-a-row',
                        ['国服', 1, null],
                        ['火炬之光只有两级'],
                    ],
                },
            ],
        });

        expect(out.catalogs[0]?.zoneConfigs).toEqual([
            ['国服', '赛季', '普通'],
            ['火炬之光只有两级'],
        ]);
    });
});

describe('sanitizeConfig — 标量与数值', () => {
    it('类型不对的开关回退默认，不抛错', () => {
        const out = sanitizeConfig({ enabled: 'yes', debug: 1, allowAtBotTrigger: null });

        expect(out.enabled).toBe(true);
        expect(out.debug).toBe(false);
        expect(out.allowAtBotTrigger).toBe(true);
    });

    it('**命令前缀不接受外部输入**（开发期常量, 只能改源码后重跑帮助生成）', () => {
        // 允许 WebUI / 配置文件改前缀, 就会出现"帮助图上的指令敲不出来"
        for (const attempt of ['/cp', '   ', 42, null]) {
            expect(sanitizeConfig({ commandPrefix: attempt }).commandPrefix).toBe('#currency');
        }
    });

    it('pushIntervalMs 为负数或非有限数时回退默认', () => {
        expect(sanitizeConfig({ pushIntervalMs: -1 }).pushIntervalMs).toBe(100);
        expect(sanitizeConfig({ pushIntervalMs: Number.NaN }).pushIntervalMs).toBe(100);
        expect(sanitizeConfig({ pushIntervalMs: 0 }).pushIntervalMs).toBe(0);
    });

    it('损坏的配置输入不抛错，整体回退默认', () => {
        for (const broken of [null, undefined, 'oops', 42, []]) {
            expect(() => sanitizeConfig(broken)).not.toThrow();
            expect(sanitizeConfig(broken).commandPrefix).toBe('#currency');
        }
    });
});

describe('sanitizeConfig — adminUsers（字符串列表 / 超管名单）', () => {
    it('WebUI 的逗号分隔文本在清洗层一次性转数组', () => {
        const out = sanitizeConfig({ adminUsers: ' 958341409 , 10001 ,, 10002 , ' });

        expect(out.adminUsers).toEqual(['958341409', '10001', '10002']);
    });

    it('已经是数组时同样规范化', () => {
        const out = sanitizeConfig({ adminUsers: ['958341409', '', '  10001  '] });

        expect(out.adminUsers).toEqual(['958341409', '10001']);
    });

    it('数字形式的 QQ 号也接受（JSON 里可能是 number）', () => {
        const out = sanitizeConfig({ adminUsers: [958341409] });

        expect(out.adminUsers).toEqual(['958341409']);
    });
});
