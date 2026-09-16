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
    /** 读取数据目录下的文件内容 (返回 null 表示文件不存在) */
    readDataFile(filename: string): string | null;
    /** 初始化 `pluginState` 指向本环境 (模拟一次插件加载) */
    init(): void;
    /** 清空发送记录 */
    clearSent(): void;
    /** 删除临时目录 */
    dispose(): void;
}

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

    const logger = {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
    };

    const ctx = {
        pluginName: 'napcat-plugin-currency-price',
        pluginPath: root,
        configPath,
        dataPath,
        adapterName: 'test-adapter',
        logger,
        pluginManager: { config: {} },
        actions: {
            call: async (action: string, params: Record<string, unknown>) => {
                if (action === 'send_msg') {
                    sent.push(String(params.message));
                }
                return { user_id: '10000' };
            },
        },
    } as unknown as NapCatPluginContext;

    return {
        ctx,
        root,
        dataPath,
        sent,
        readDataFile(filename) {
            const filePath = path.join(dataPath, filename);
            return fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf-8') : null;
        },
        init() {
            pluginState.init(ctx);
        },
        clearSent() {
            sent.length = 0;
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
