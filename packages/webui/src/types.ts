/** WebUI 前端类型定义 */
import type { PluginConfig } from '@napcat-plugin-template/shared';

export type {
    PluginConfig,
    GroupConfig,
    CatalogConfig,
    CurrencyConfig,
    ApiResponse,
} from '@napcat-plugin-template/shared';

export interface PluginStatus {
    pluginName: string;
    uptime: number;
    uptimeFormatted: string;
    config: PluginConfig;
    stats: {
        processed: number;
        todayProcessed: number;
        lastUpdateDay: string;
    };
    /** 各游戏的数据状态。`readAt` 是**游戏级**的，不是整次抓取的时间 */
    games: GameStatus[];
}

/** 一个游戏的数据状态 */
export interface GameStatus {
    name: string;
    /** 该游戏最近一次成功抓取的时刻 (ISO 8601 UTC)；从未成功过时为空串 */
    readAt: string;
    /** 最近一次抓取尝试的失败原因；成功时为 null */
    lastError: string | null;
}

/** 浏览器状态。来自 `/chrome/status`，**只读缓存、零副作用** */
export interface BrowserStatus {
    available: boolean;
    /** 可执行文件路径 */
    path: string | null;
    /** 从哪一档找到的：配置 / 共享安装路径 / 系统浏览器 */
    source: 'config' | 'shared' | 'system' | null;
    /** 只有完整检测（launch 过）才有版本号 */
    version: string | null;
    /** 最近一次检测时刻；**从未检测过时为 null**，此时显示「未检测」而不是「不可用」 */
    checkedAt: string | null;
    error: string | null;
}

/** 安装进度 */
export interface InstallState {
    running: boolean;
    progress: {
        phase: 'downloading' | 'extracting' | 'done';
        percent: number;
        source: string | null;
        message: string;
    } | null;
    error: string | null;
    path: string | null;
}

export interface GroupInfo {
    group_id: number;
    group_name: string;
    member_count: number;
    max_member_count: number;
    enabled: boolean;
    /** 定时推送时间（如 '08:30'），null 表示未设置（模板默认不使用，按需扩展） */
    scheduleTime?: string | null;
}

/**
 * 一个会话的订阅关系。来自 `/sessions`，即 `state.json` 的真实内容。
 *
 * ⚠️ **不是 `PluginConfig.groupConfigs`**。群管理页要展示的是"订阅了什么、收不收推送"，
 * 那在 `state.json` 里；`groupConfigs` 在本插件里只有会话级启用开关一个字段。
 */
export interface SessionRecord {
    /** 是否接收主动推送。**默认关闭**——订阅了游戏不等于要收推送 */
    notifyEnabled: boolean;
    /** 该会话订阅的游戏名 */
    enabledGames: string[];
}

/** `/sessions` 的返回：会话键（`group:555` / `private:789`）→ 订阅关系 */
export type SessionMap = Record<string, SessionRecord>;
