/**
 * 订阅关系存储 —— `state.json`
 *
 * 见设计文档 §7.1: **纯粹的订阅关系表**, 只记"哪个会话开了通知、订了哪些游戏"。
 *
 * ⚠️ **本文件不含任何全局时间戳**。早期设计的 `lastDataReadAt` / `lastDataSuccess` 已删除——
 * 新鲜度判定下沉到 `data.json` 的游戏级 `readAt` (片 03/05), 全局时间戳失去存在理由。
 * 往这里加时间戳字段前先读 §7.1, 那是数据状态与订阅关系的边界。
 *
 * 每次读改写都**现读现写**, 不在内存里缓存一份: 文件只有几百字节, 而指令是低频操作,
 * 缓存换不来什么, 却要引入"内存与磁盘谁覆盖谁"的一致性问题 (WebUI 也会读它, 见片 10)。
 */

import { pluginState } from '../core/state';
import { readJsonSafe, writeJsonAtomic } from './atomic-json';

/** 数据文件名 */
export const SESSION_STATE_FILENAME = 'state.json';

/** 结构版本号。将来字段语义变更时用它区分旧文件 */
export const SESSION_STATE_VERSION = 1;

/** 单个会话的订阅关系 */
export interface SessionRecord {
    /** 是否接收主动推送。**默认关闭**——见 CONTEXT.md 的"默认值语义声明" */
    notifyEnabled: boolean;
    /** 该会话订阅的游戏名 (精确匹配 `catalogs[].name`) */
    enabledGames: string[];
}

/** `state.json` 的整体结构 */
export interface SessionState {
    version: number;
    sessions: Record<string, SessionRecord>;
}

/** 空结构。文件缺失或损坏时都是它——**不是**"默认全开" */
function emptyState(): SessionState {
    return { version: SESSION_STATE_VERSION, sessions: {} };
}

/** 新建会话的默认值: 通知关闭、不订阅任何游戏 */
function defaultSession(): SessionRecord {
    return { notifyEnabled: false, enabledGames: [] };
}

function isObject(v: unknown): v is Record<string, unknown> {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * 清洗从磁盘读到的订阅关系
 *
 * 与配置清洗同理 (见 docs/config-pattern.md): 外部输入一律先清洗再进内存。
 * 单个会话不合法只丢弃该会话, 其余保留——一处手改坏了不该拖垮所有人的订阅。
 */
export function sanitizeSessionState(raw: unknown): SessionState {
    const out = emptyState();
    if (!isObject(raw) || !isObject(raw.sessions)) return out;

    for (const [key, value] of Object.entries(raw.sessions)) {
        if (!isObject(value)) continue;
        out.sessions[key] = {
            notifyEnabled: value.notifyEnabled === true,
            enabledGames: Array.isArray(value.enabledGames)
                ? [...new Set(value.enabledGames.filter((g): g is string => typeof g === 'string'))]
                : [],
        };
    }

    return out;
}

/**
 * 会话订阅存储 (单例)
 *
 * 延迟实例化: 类本身在 import 时不触碰 `ctx` / 文件 IO, 由使用方在**方法内部**取实例。
 */
export class SessionStore {
    private static instance: SessionStore | null = null;

    private constructor() {
        /* 构造期零 IO —— 见 docs/store-pattern.md 的"为什么不能在模块加载期读数据" */
    }

    /** 单例入口。**不要**在模块加载期调用 */
    static getInstance(): SessionStore {
        if (!SessionStore.instance) {
            SessionStore.instance = new SessionStore();
        }
        return SessionStore.instance;
    }

    /** 会话键 (`group:123` / `private:789`) → 订阅关系; 未订阅过的会话返回默认值 */
    getSession(sessionKey: string): SessionRecord {
        return this.read().sessions[sessionKey] ?? defaultSession();
    }

    /** 全部会话的订阅关系 (WebUI 的会话一览用) */
    getSessions(): Record<string, SessionRecord> {
        return this.read().sessions;
    }

    /** 切换某会话的通知开关 */
    setNotifyEnabled(sessionKey: string, enabled: boolean): void {
        const state = this.read();
        state.sessions[sessionKey] = { ...this.recordOf(state, sessionKey), notifyEnabled: enabled };
        this.write(state);
    }

    /**
     * 订阅一个游戏。**幂等**——重复订阅不报错、不产生重复项
     *
     * 游戏名是否合法 (在不在 `catalogs` 里) 由分发层的 `validateArgs` 负责,
     * 此处只管写。
     */
    addGame(sessionKey: string, gameName: string): void {
        const state = this.read();
        const record = this.recordOf(state, sessionKey);
        if (!record.enabledGames.includes(gameName)) {
            record.enabledGames.push(gameName);
        }
        state.sessions[sessionKey] = record;
        this.write(state);
    }

    /**
     * 退订一个游戏。**幂等**——退订没订过的游戏不报错、不抛异常
     */
    removeGame(sessionKey: string, gameName: string): void {
        const state = this.read();
        const record = this.recordOf(state, sessionKey);
        record.enabledGames = record.enabledGames.filter((name) => name !== gameName);
        state.sessions[sessionKey] = record;
        this.write(state);
    }

    /** 取出会话记录 (不存在则就地建一个默认的, 供写入方改) */
    private recordOf(state: SessionState, sessionKey: string): SessionRecord {
        return state.sessions[sessionKey] ?? defaultSession();
    }

    /** 现读。损坏时 readJsonSafe 已把坏文件备份走 */
    private read(): SessionState {
        const { data, corrupted } = readJsonSafe(
            pluginState.getDataFilePath(SESSION_STATE_FILENAME),
            emptyState(),
        );
        const state = sanitizeSessionState(data);

        if (corrupted) {
            // 备份 + 初始化为空结构。**不阻塞启动**——调用方拿到的永远是能用的空表
            pluginState.logger.warn('订阅关系文件损坏, 已备份为 *.bak 并初始化为空');
            this.write(state);
        }

        return state;
    }

    /** 立即落盘 (原子写)。写失败只记日志, 不影响正在处理的这条消息 */
    private write(state: SessionState): void {
        try {
            writeJsonAtomic(
                pluginState.getDataFilePath(SESSION_STATE_FILENAME),
                state,
                2,
            );
        } catch (error) {
            pluginState.logger.error('保存订阅关系失败:', error);
        }
    }
}
