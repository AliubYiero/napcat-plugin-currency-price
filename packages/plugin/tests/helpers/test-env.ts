/**
 * 测试基建: 假 ctx + 临时数据目录
 *
 * 只在 **NapCat 宿主边界**上造假 (ctx 的 actions / logger / 路径), 其余全部跑真实的
 * 文件系统——store 的落盘、原子写、`*.bak` 备份因此是**真跑出来的**, 不是断言出来的。
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { vi } from 'vitest';
import type { OB11Message } from 'napcat-types/napcat-onebot';
import type { NapCatPluginContext } from 'napcat-types/napcat-onebot/network/plugin/types';
import { pluginState } from '../../src/core/state';

export interface TestEnv {
    ctx: NapCatPluginContext;
    /** 本环境的根目录。传给 `createTestEnv(root)` 可模拟插件重载 */
    root: string;
    /** 插件数据目录 (`state.json` 等落在这里) */
    dataPath: string;
    /** 本环境里机器人发出的全部消息文本, 按发送顺序 */
    sent: string[];
    /**
     * 同上, 但带上了**发给了谁**。零推送范围类断言（群 / 私聊各自独立、推给了哪个会话）
     * 必须有目标才看得出, 只看文本会漏掉"发错人"这一类错。
     */
    sentMessages: SentMessage[];
    /** 读取数据目录下的文件内容 (返回 null 表示文件不存在) */
    readDataFile(filename: string): string | null;
    /** 初始化 `pluginState` 指向本环境 (模拟一次插件加载) */
    init(): void;
    /** 清空发送记录 */
    clearSent(): void;
    /**
     * 调用一个已注册的 API 路由。
     *
     * @param key 形如 `GET /chrome/status`（方法是注册时用的那个）
     * @returns 该路由写出的状态码与响应体
     */
    callRoute(key: string, req?: unknown): Promise<RouteCall>;
    /** 删除临时目录 */
    dispose(): void;
}

/** 一条已发出的消息: 内容 + 目标 */
export interface SentMessage {
    messageType: string;
    /** 群号或 QQ 号 (字符串形式, 与发送参数的取值一致) */
    target: string;
    message: string;
    /** 发出时刻。测试用假时钟时可读出虚拟时间, 逐条间隔因此能被直接断言 */
    sentAt: number;
}

/** 一次 API 路由调用的结果 */
export interface RouteCall {
    status: number;
    body: unknown;
}

/** 已注册路由的 handler。**故意用宽类型**: 测试只关心它写出了什么 */
type RouteHandler = (req: never, res: never) => unknown;

/**
 * 建一个隔离的宿主环境。**不自动初始化 pluginState**——由用例决定何时"加载插件"
 *
 * @param root 复用已有的根目录。传入上一次环境的 root 即可模拟**插件重载**:
 *             数据目录不变、宿主上下文全新
 */
export function createTestEnv(root?: string): TestEnv {
    root ??= fs.mkdtempSync(path.join(os.tmpdir(), 'currency-price-'));
    const dataPath = path.join(root, 'data');
    const configPath = path.join(root, 'config.json');
    const sent: string[] = [];
    const sentMessages: SentMessage[] = [];

    const logger = {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
    };

    /** 已注册的 API 路由: `GET /chrome/status` → handler */
    const routes = new Map<string, RouteHandler>();
    /** 记录路由注册, 供 `callRoute` 调用 */
    const register = (method: string) => (urlPath: string, handler: RouteHandler): void => {
        routes.set(`${method} ${urlPath}`, handler);
    };

    const ctx = {
        pluginName: 'napcat-plugin-currency-price',
        pluginPath: root,
        configPath,
        dataPath,
        adapterName: 'test-adapter',
        logger,
        pluginManager: { config: {} },
        // 配置 Schema 工厂。这里只做**身份透传**（返回收到的项）: 路由测试关心的是
        // "schema 能不能构建出来", 不是 NapCat 各控件的真实行为
        NapCatConfig: {
            combine: (...items: unknown[]) => items.flat(),
            html: (content: string) => ({ type: 'html', content }),
            plainText: (content: string) => ({ type: 'plainText', content }),
            text: (key: string) => ({ type: 'text', key }),
            boolean: (key: string) => ({ type: 'boolean', key }),
            number: (key: string) => ({ type: 'number', key }),
            select: (key: string) => ({ type: 'select', key }),
            multiSelect: (key: string) => ({ type: 'multiSelect', key }),
        },
        actions: {
            call: async (action: string, params: Record<string, unknown>) => {
                if (action === 'send_msg') {
                    const message = String(params.message);
                    sent.push(message);
                    sentMessages.push({
                        messageType: String(params.message_type),
                        target: String(params.group_id ?? params.user_id ?? ''),
                        message,
                        sentAt: Date.now(),
                    });
                }
                return { user_id: '10000' };
            },
        },
        router: {
            // 鉴权与免鉴权在测试里不做区分: 断言的是"这个路由写出了什么", 不是它挂在哪
            get: register('GET'),
            post: register('POST'),
            getNoAuth: register('GET'),
            postNoAuth: register('POST'),
            static: () => {},
            staticOnMem: () => {},
            page: () => {},
        },
    } as unknown as NapCatPluginContext;

    return {
        ctx,
        root,
        dataPath,
        sent,
        sentMessages,
        readDataFile(filename) {
            const filePath = path.join(dataPath, filename);
            return fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf-8') : null;
        },
        init() {
            pluginState.init(ctx);
        },
        clearSent() {
            sent.length = 0;
            sentMessages.length = 0;
        },
        async callRoute(key, req = {}) {
            const handler = routes.get(key);
            if (!handler) throw new Error(`路由未注册：${key}`);

            let status = 200;
            let body: unknown = null;

            const res = {
                status(code: number) {
                    status = code;

                    return res;
                },
                json(payload: unknown) {
                    body = payload;

                    return res;
                },
            };

            await (handler as (a: unknown, b: unknown) => unknown)(req, res);

            return { status, body };
        },
        dispose() {
            fs.rmSync(root, { recursive: true, force: true });
        },
    };
}

/** 读取当前数据目录下 `state.json` 的解析结果 (返回 null 表示文件不存在) */
export function readStateFile(env: TestEnv): unknown {
    const raw = env.readDataFile('state.json');
    return raw === null ? null : JSON.parse(raw);
}

/** 造一条群消息。`role` 是平台给的群成员身份 (`member` = 普通成员) */
export function groupMessage(
    text: string,
    options: { groupId?: string; userId?: string; role?: 'owner' | 'admin' | 'member' } = {},
): OB11Message {
    const { groupId = '555', userId = '10001', role = 'member' } = options;

    return {
        post_type: 'message',
        message_type: 'group',
        sub_type: 'normal',
        group_id: Number(groupId),
        user_id: Number(userId),
        raw_message: text,
        message: text,
        sender: { user_id: Number(userId), role },
    } as unknown as OB11Message;
}

/** 造一条私聊消息。`subType: 'friend'` 是机器人好友, `'group'` 是群临时会话 */
export function privateMessage(
    text: string,
    options: { userId?: string; subType?: 'friend' | 'group' } = {},
): OB11Message {
    const { userId = '10002', subType = 'friend' } = options;

    return {
        post_type: 'message',
        message_type: 'private',
        sub_type: subType,
        user_id: Number(userId),
        raw_message: text,
        message: text,
        sender: { user_id: Number(userId) },
    } as unknown as OB11Message;
}
