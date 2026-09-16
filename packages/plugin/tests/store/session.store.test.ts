import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SessionStore } from '../../src/store/session.store';
import { createTestEnv, readStateFile, type TestEnv } from '../helpers/test-env';

let env: TestEnv;
let store: SessionStore;

beforeEach(() => {
    env = createTestEnv();
    env.init();
    store = SessionStore.getInstance();
});

afterEach(() => {
    env.dispose();
});

describe('SessionStore — 默认值与落盘', () => {
    it('没订阅过的会话是默认值: 通知关闭、未订阅任何游戏', () => {
        expect(store.getSession('group:123456')).toEqual({
            notifyEnabled: false,
            enabledGames: [],
        });
    });

    it('**默认关闭**: 读一个没订阅过的会话不会在磁盘上留下痕迹', () => {
        store.setNotifyEnabled('group:111', true);

        store.getSession('group:222');

        expect(readStateFile(env)).toEqual({
            version: 1,
            sessions: { 'group:111': { notifyEnabled: true, enabledGames: [] } },
        });
    });

    it('开启通知后落盘, 重载插件后仍然是开启', () => {
        store.setNotifyEnabled('group:123456', true);
        store.addGame('group:123456', '流放之路2');

        expect(JSON.parse(env.readDataFile('state.json') ?? '{}')).toEqual({
            version: 1,
            sessions: { 'group:123456': { notifyEnabled: true, enabledGames: ['流放之路2'] } },
        });

        // 模拟插件重载: 数据目录不变, 宿主上下文全新
        const reloaded = createTestEnv(env.root);
        reloaded.init();

        expect(SessionStore.getInstance().getSession('group:123456')).toEqual({
            notifyEnabled: true,
            enabledGames: ['流放之路2'],
        });
    });

    it('关闭通知同样落盘', () => {
        store.setNotifyEnabled('group:123456', true);
        store.setNotifyEnabled('group:123456', false);

        expect(store.getSession('group:123456').notifyEnabled).toBe(false);
    });
});

describe('SessionStore — 损坏恢复', () => {
    it('**文件损坏不阻塞启动**: 备份为 *.bak、初始化为空结构, 读出来是默认值', () => {
        fs.mkdirSync(env.dataPath, { recursive: true });
        fs.writeFileSync(path.join(env.dataPath, 'state.json'), '{ 手改坏的内容', 'utf-8');

        expect(() => store.getSession('group:123456')).not.toThrow();
        expect(store.getSession('group:123456')).toEqual({
            notifyEnabled: false,
            enabledGames: [],
        });

        expect(fs.readFileSync(path.join(env.dataPath, 'state.json.bak'), 'utf-8')).toBe(
            '{ 手改坏的内容',
        );
        expect(readStateFile(env)).toEqual({ version: 1, sessions: {} });
    });

    it('损坏恢复后仍可正常写入订阅', () => {
        fs.mkdirSync(env.dataPath, { recursive: true });
        fs.writeFileSync(path.join(env.dataPath, 'state.json'), '不是 JSON', 'utf-8');

        store.addGame('group:123456', '流放之路2');

        expect(store.getSession('group:123456').enabledGames).toEqual(['流放之路2']);
        expect(readStateFile(env)).toEqual({
            version: 1,
            sessions: { 'group:123456': { notifyEnabled: false, enabledGames: ['流放之路2'] } },
        });
    });

    it('单个会话条目被改坏时只丢该条, 其余会话的订阅保留', () => {
        fs.mkdirSync(env.dataPath, { recursive: true });
        fs.writeFileSync(
            path.join(env.dataPath, 'state.json'),
            JSON.stringify({
                version: 1,
                sessions: {
                    'group:111': { notifyEnabled: true, enabledGames: ['流放之路2'] },
                    'group:222': '被改成了字符串',
                    'group:333': { notifyEnabled: 'yes', enabledGames: '流放之路1' },
                },
            }),
            'utf-8',
        );

        expect(store.getSession('group:111')).toEqual({
            notifyEnabled: true,
            enabledGames: ['流放之路2'],
        });
        expect(store.getSession('group:222')).toEqual({ notifyEnabled: false, enabledGames: [] });
        expect(store.getSession('group:333')).toEqual({ notifyEnabled: false, enabledGames: [] });
    });
});

describe('SessionStore — 订阅与退订', () => {
    it('重复订阅同一个游戏只留一项', () => {
        store.addGame('group:123456', '流放之路2');
        store.addGame('group:123456', '流放之路2');

        expect(store.getSession('group:123456').enabledGames).toEqual(['流放之路2']);
    });

    it('退订一个没订过的游戏不报错, 也不动其它订阅', () => {
        store.addGame('group:123456', '流放之路2');

        expect(() => store.removeGame('group:123456', '火炬之光')).not.toThrow();
        expect(store.getSession('group:123456').enabledGames).toEqual(['流放之路2']);
    });

    it('退订一个从没订阅过的会话不报错, 也不凭空建档', () => {
        store.removeGame('group:123456', '火炬之光');

        expect(store.getSession('group:123456').enabledGames).toEqual([]);
    });

    it('**订阅顺序即推送顺序**: 退掉中间一个后, 其余保持原序', () => {
        store.addGame('group:123456', '流放之路2');
        store.addGame('group:123456', '流放之路1');
        store.addGame('group:123456', '火炬之光');

        store.removeGame('group:123456', '流放之路1');

        expect(store.getSession('group:123456').enabledGames).toEqual([
            '流放之路2',
            '火炬之光',
        ]);
    });
});

describe('SessionStore — 会话之间互相独立', () => {
    it('**群与私聊的订阅互不影响**: 开一个群的通知, 私聊与别的群不受牵连', () => {
        store.setNotifyEnabled('group:123456', true);
        store.addGame('group:123456', '流放之路2');

        expect(store.getSession('private:789')).toEqual({
            notifyEnabled: false,
            enabledGames: [],
        });
        expect(store.getSession('group:999')).toEqual({
            notifyEnabled: false,
            enabledGames: [],
        });
    });

    it('同一个 QQ 号: 私聊订的游戏不进入它所在群的订阅', () => {
        store.addGame('private:789', '火炬之光');

        expect(store.getSession('group:789').enabledGames).toEqual([]);
    });
});

describe('SessionStore — state.json 的形状', () => {
    it('**不存在任何全局时间戳字段**——它是纯粹的订阅关系表', () => {
        store.setNotifyEnabled('group:123456', true);
        store.addGame('group:123456', '流放之路2');

        const state = readStateFile(env) as Record<string, unknown>;

        // 早期设计的 lastDataReadAt / lastDataSuccess 已删除, 数据状态归 data.json (片 03)
        expect(Object.keys(state).sort()).toEqual(['sessions', 'version']);
        expect(Object.keys((state.sessions as Record<string, object>)['group:123456']).sort()).toEqual(
            ['enabledGames', 'notifyEnabled'],
        );
    });
});
