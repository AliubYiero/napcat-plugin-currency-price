/**
 * 插件配置模块
 * 定义默认配置值和 WebUI 配置 Schema
 */

import type {
    NapCatPluginContext,
    PluginConfigSchema,
} from 'napcat-types/napcat-onebot/network/plugin/types';
import type { CatalogConfig, PluginConfig } from './types';

/** 定时推送小时集合的取值范围 (本地时间, 整点) */
export const VALID_PUSH_HOURS: number[] = Array.from(
    { length: 24 },
    (_, hour) => hour,
);

/**
 * 默认 catalog 清单 (三分区, 合计 10 个区服组合)。
 *
 * ⚠️ 下面的注释是**实测得出的领域知识, 不是说明文字**。它们是"为什么这份清单与
 * 隔壁那份不通用"的唯一记录, 改动时**必须原样保留**。
 *
 * ⚠️ **三份 `currencyList` 彼此不通用, 不要"顺手统一"**。同名通货跨游戏独立, 且站点上
 * 各专区提供的通货本就不同——把流放之路2 的清单照抄给流放之路1, 表现是**静默产出 0**
 * (名称匹配不上, 不报错)。这正是游戏级 `missing` 要兜的那类配置错误。
 */
export const CATALOGS: CatalogConfig[] = [
    {
        name: '流放之路2',
        pageUrl:
            'https://qiandao.com/currency/currency-zone?catalogName=%E6%B5%81%E6%94%BE2%E4%B8%93%E5%8C%BA&islandId=301000&tagIds=[1707645,1708106,1824627,1708366,1815176,1856267,1708370,1707637,1708367,1708373,1708375,1820850,1815650]&attributeId=904221228984762040&entryId=1707645&entryType=TAG',
        zoneConfigs: [
            ['国服', '赛季', '普通'],
            ['国际服', '赛季', '普通'],
        ],
        // 详情（成交量 + 挂单）**逐通货开、默认关闭**: 每个开了详情的通货都要多花一次
        // 点击与一次面板等待。默认形态是"有价格、没有盘口", 那已经是一个能用的答案
        currencyList: [{ name: '神圣石', detail: false }],
    },
    {
        name: '流放之路1',
        pageUrl:
            'https://qiandao.com/currency/currency-zone?catalogName=%E6%B5%81%E6%94%BE%E4%B9%8B%E8%B7%AF%E4%B8%93%E5%8C%BA&islandId=300445&tagIds=[1837988,1837987,1837989]&attributeId=904221228984762040&entryId=1837988&entryType=TAG',
        // 实测该分区没有「闪回赛季」，赛季只有「永久 / 赛季」两种
        zoneConfigs: [
            ['国服', '赛季', '普通'],
            ['国际服', '赛季', '普通'],
        ],
        // 该分区没有「流放2金币」系列，也没有「悉妮蔻拉的发丝」（只有名称相近的「辛格拉的发辫」），
        // 因此清单与流放之路2 不通用，照抄会静默产出 0
        currencyList: [{ name: '神圣石', detail: false }],
    },
    {
        name: '火炬之光',
        pageUrl:
            'https://qiandao.com/currency/currency-zone?catalogName=%E7%81%AB%E7%82%AC%E4%B9%8B%E5%85%89%E4%B8%93%E5%8C%BA&islandId=300444&tagIds=[1560053]&attributeId=904221228984762040&entryId=1560053&entryType=TAG',
        // 该分区只有两级，且「非赛季」下没有「专家」难度，故只取「赛季」的两个组合
        zoneConfigs: [
            ['赛季', '普通'],
            ['赛季', '专家'],
        ],
        // 整个专区只有这一个通货
        currencyList: [{ name: '初火源质', detail: false }],
    },
];

/**
 * 默认配置
 *
 * ⚠️ `commandPrefix` 是**开发期常量**, 而非用户配置项: 它被烧进帮助图片与文本映射
 * (`scripts/generateHelp/` 从本对象读它当渲染用的前缀)。改这一行之后**必须**重跑
 * `pnpm help:generate`, 否则用户看到的帮助里的指令敲不出来。清洗层刻意忽略外部输入,
 * 见 `core/state.ts` 的 `sanitizeConfig`。
 */
export const DEFAULT_CONFIG: PluginConfig = {
    enabled: true,
    debug: false,
    commandPrefix: '#currency',
    allowAtBotTrigger: true,
    adminUsers: [],
    groupConfigs: {},
    // 默认全选: 每个整点都推送
    pushHours: [...VALID_PUSH_HOURS],
    catalogs: CATALOGS,
    pushIntervalMs: 100,
    chromeExecutablePath: '',
};

/** `pushIntervalMs` 的合法下界: 0 表示不间隔, 负数无意义 */
export const MIN_PUSH_INTERVAL_MS = 0;

/**
 * 构建 WebUI 配置 Schema
 *
 * 使用 ctx.NapCatConfig 提供的构建器方法生成配置界面：
 *   - boolean(key, label, defaultValue?, description?, reactive?)  → 开关
 *   - text(key, label, defaultValue?, description?, reactive?)     → 文本输入
 *   - number(key, label, defaultValue?, description?, reactive?)   → 数字输入
 *   - select(key, label, options, defaultValue?, description?)     → 下拉单选
 *   - multiSelect(key, label, options, defaultValue?, description?) → 下拉多选
 *   - html(content)     → 自定义 HTML 展示（不保存值）
 *   - plainText(content) → 纯文本说明
 *   - combine(...items)  → 组合多个配置项为 Schema
 */
export function buildConfigSchema(
    ctx: NapCatPluginContext,
): PluginConfigSchema {
    return ctx.NapCatConfig.combine(
        // 插件信息头部
        ctx.NapCatConfig.html(`
            <div style="padding: 16px; background: #FB7299; border-radius: 12px; margin-bottom: 20px; color: white;">
                <h3 style="margin: 0 0 6px 0; font-size: 18px; font-weight: 600;">千岛通货价格</h3>
                <p style="margin: 0; font-size: 13px; opacity: 0.85;">定时抓取千岛各游戏的通货价格并推送到群聊 / 私聊</p>
            </div>
        `),
        ctx.NapCatConfig.boolean(
            'enabled',
            '启用插件',
            true,
            '关闭后不响应任何指令，也不做定时推送',
        ),
        // ⚠️ `commandPrefix` 刻意**不在此生成控件**: 它是开发期常量, 不是用户配置项——
        // 前缀被烧进帮助图片 (`pnpm help:generate` 的产物), 运行期能改就意味着图上的
        // 指令与实际生效的指令可能对不上。改它 = 改 `DEFAULT_CONFIG` + 重跑生成。
        ctx.NapCatConfig.text(
            'adminUsers',
            '超级管理员 QQ 号',
            '',
            '多个 QQ 号用英文逗号分隔。超管在别人的群里也能执行管理指令',
        ),
        ctx.NapCatConfig.boolean(
            'allowAtBotTrigger',
            '允许 @机器人 触发',
            true,
            '开启后 `@机器人 #currency help` 也能触发指令',
        ),
        ctx.NapCatConfig.number(
            'pushIntervalMs',
            '推送间隔（毫秒）',
            DEFAULT_CONFIG.pushIntervalMs,
            '逐条推送之间的间隔。QQ 服务端的频控边界因部署而异，被限流时调大',
        ),
        ctx.NapCatConfig.multiSelect(
            'pushHours',
            '定时推送小时',
            VALID_PUSH_HOURS.map((hour) => ({
                label: `${String(hour).padStart(2, '0')}:00`,
                value: hour,
            })),
            [...VALID_PUSH_HOURS],
            '在选中的整点抓取并推送（本地时间）',
            true,
        ),
        ctx.NapCatConfig.text(
            'chromeExecutablePath',
            '浏览器路径',
            '',
            '留空则按「共享安装路径 → 系统浏览器常见路径」自动检测。仅在自动检测失败时需要手填',
        ),
        // ⚠️ `catalogs` 刻意**不在此生成控件**: 它含 `zoneConfigs: string[][]`, 而 Schema 只有
        // boolean/text/number/select/multiSelect/html/combine, **没有数组或表格控件**, 表达不出来。
        // 它仍走完整四环节(类型/默认值/清洗/运行时读写), 只是编辑入口换成自定义 WebUI 页面。
        // 见设计文档 §5.2。
        ctx.NapCatConfig.plainText(
            '游戏分区配置请在插件页面的「分区配置」页中编辑。',
        ),
    );
}
