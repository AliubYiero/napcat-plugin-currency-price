/**
 * 共享类型定义
 * 插件后端（plugin）与 WebUI 前端（webui）共用的接口和类型。
 * 修改此文件后两端类型同步生效，无需手动维护两份定义。
 */

// ==================== 插件配置 ====================

/**
 * 插件主配置接口
 * 在此定义你的插件所需的所有配置项
 */
export interface PluginConfig {
    /** 全局开关：是否启用插件功能 */
    enabled: boolean;
    /** 调试模式：启用后输出详细日志 */
    debug: boolean;
    /** 指令前缀，缺省 `#currency`，运行期可改 */
    commandPrefix: string;
    /** 允许 `@机器人 + 指令` 触发 (见 instruction-pattern 1.1) */
    allowAtBotTrigger: boolean;
    /**
     * 超管 QQ 号名单。**WebUI 以逗号分隔文本输入, 清洗层一次性转数组**;
     * 运行期始终是干净的 `string[]`, 使用方直接读数组、不重复解析字符串。
     */
    adminUsers: string[];
    /** 按群的单独配置 */
    groupConfigs: Record<string, GroupConfig>;
    /**
     * 整点推送的小时集合 (本地时间, 取值 `0`~`23`)。
     * **空数组 = 不做定时推送**, 是合法语义, 清洗时不回退默认。
     */
    pushHours: number[];
    /** 游戏配置。**不生成 Schema 控件** (NapCat 无数组/表格控件), 由自定义 WebUI 页编辑 */
    catalogs: CatalogConfig[];
    /** 逐条推送之间的间隔 (毫秒)。频控边界在 QQ 服务端, 因部署而异 */
    pushIntervalMs: number;
    /** 手动指定的浏览器可执行文件路径; 为空则走检测顺序 */
    chromeExecutablePath: string;
}

/**
 * 游戏配置
 *
 * 一个游戏商品专区 = 一份抓取目标声明。`name` 同时是 `data.json` 的键与
 * `game add <游戏名>` 的参数。
 */
export interface CatalogConfig {
    /** 游戏名。同时是 data.json 的键与指令参数 `game add <游戏名>` */
    name: string;
    /**
     * 站点页面 URL, **原样存整条**(含 catalogName/islandId/tagIds/... 六个 query 参数)。
     * 不拆成结构字段: 那几个 query 参数是站点改版时最先变的东西, 拆开会让
     * "从浏览器复制一条 URL" 变成手工拆解六个参数。
     */
    pageUrl: string;
    /** 要抓的通货名, 与站点名称**精确匹配** */
    currencyList: string[];
    /** 要抓的区服组合, **层数随游戏而变** (流放之路 3 级、火炬之光 2 级) */
    zoneConfigs: string[][];
}

/**
 * 群配置
 */
export interface GroupConfig {
    /** 是否启用此群的功能 */
    enabled?: boolean;
    // TODO: 在这里添加群级别的配置项
}

// ==================== API 响应 ====================

/**
 * 统一 API 响应格式
 */
export interface ApiResponse<T = unknown> {
    /** 状态码，0 表示成功，-1 表示失败 */
    code: number;
    /** 错误信息（仅错误时返回） */
    message?: string;
    /** 响应数据（仅成功时返回） */
    data?: T;
}
