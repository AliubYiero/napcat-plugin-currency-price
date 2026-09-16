/** WebUI 前端类型定义 */
import type { PluginConfig } from '@napcat-plugin-template/shared';

export type { PluginConfig, GroupConfig, ApiResponse } from '@napcat-plugin-template/shared';

export interface PluginStatus {
    pluginName: string
    uptime: number
    uptimeFormatted: string
    config: PluginConfig
    stats: {
        processed: number
        todayProcessed: number
        lastUpdateDay: string
    }
    /** 各游戏的数据状态。`readAt` 是**游戏级**的，不是整次抓取的时间 */
    games: GameStatus[]
}

/** 一个游戏的数据状态 */
export interface GameStatus {
    name: string
    /** 该游戏最近一次成功抓取的时刻 (ISO 8601 UTC)；从未成功过时为空串 */
    readAt: string
    /** 最近一次抓取尝试的失败原因；成功时为 null */
    lastError: string | null
}

/** 浏览器状态。来自 `/chrome/status`，**只读缓存、零副作用** */
export interface BrowserStatus {
    available: boolean
    /** 可执行文件路径 */
    path: string | null
    /** 从哪一档找到的：配置 / 共享安装路径 / 系统浏览器 */
    source: 'config' | 'shared' | 'system' | null
    /** 只有完整检测（launch 过）才有版本号 */
    version: string | null
    /** 最近一次检测时刻；**从未检测过时为 null**，此时显示「未检测」而不是「不可用」 */
    checkedAt: string | null
    error: string | null
}

/** 安装进度 */
export interface InstallState {
    running: boolean
    progress: {
        phase: 'downloading' | 'extracting' | 'done'
        percent: number
        source: string | null
        message: string
    } | null
    error: string | null
    path: string | null
}

export interface GroupInfo {
    group_id: number
    group_name: string
    member_count: number
    max_member_count: number
    enabled: boolean
    /** 定时推送时间（如 '08:30'），null 表示未设置（模板默认不使用，按需扩展） */
    scheduleTime?: string | null
}
