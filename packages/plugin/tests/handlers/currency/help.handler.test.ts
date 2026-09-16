import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { UserRole } from '../../../src/core/admin';
import { pluginState } from '../../../src/core/state';
import { getHelpVariant } from '../../../src/handlers/currency/help.handler';
import { handleMessage } from '../../../src/handlers/message-handler';
import { createTestEnv, groupMessage, privateMessage, type TestEnv } from '../../helpers/test-env';

function role(
    roleName: UserRole['role'],
    sessionType: 'group' | 'private' = 'group',
): UserRole {
    return {
        userId: '10001',
        role: roleName,
        from: { id: sessionType === 'group' ? '555' : '10001', type: sessionType },
    };
}

describe('getHelpVariant — 帮助版本由「角色 + 会话类型」共同决定', () => {
    it('普通用户任意会话类型都是 user 版', () => {
        expect(getHelpVariant(role('user', 'group'))).toBe('user');
        expect(getHelpVariant(role('user', 'private'))).toBe('user');
    });

    it('群管理员是 admin 版', () => {
        expect(getHelpVariant(role('admin'))).toBe('admin');
    });

    it('好友私聊用户 (privateUser) 是 admin 版——它等同 admin 权限组', () => {
        expect(getHelpVariant(role('privateUser', 'private'))).toBe('admin');
    });

    it('**群聊里的超管是 admin 版**, 不是 superAdmin 版', () => {
        // SuperAdmin 版含仅私聊可用的指令, 在群里输出会误导用户
        expect(getHelpVariant(role('superAdmin', 'group'))).toBe('admin');
    });

    it('私聊里的超管才是 superAdmin 版', () => {
        expect(getHelpVariant(role('superAdmin', 'private'))).toBe('superAdmin');
    });
});

describe('帮助文本 — 只列**真正可用**的指令', () => {
    let env: TestEnv;

    beforeEach(() => {
        env = createTestEnv();
        env.init();
    });

    afterEach(() => {
        env.dispose();
    });

    async function helpText(event: Parameters<typeof handleMessage>[1]): Promise<string> {
        env.clearSent();
        await handleMessage(env.ctx, event);
        return env.sent.at(-1) ?? '';
    }

    it('admin 版列出 notify / game 的开关与订阅子指令', async () => {
        const text = await helpText(groupMessage('#currency help', { role: 'admin' }));

        expect(text).toContain('#currency notify on|off');
        expect(text).toContain('#currency game add|remove');
    });

    it('**不预告尚未实现的指令**: 帮助里不出现 price, 也不留"待实现"的空话', async () => {
        const text = await helpText(groupMessage('#currency help', { role: 'admin' }));

        expect(text).not.toContain('price');
        expect(text).not.toContain('待');
    });

    it('user 版只列所有人都能用的指令', async () => {
        const text = await helpText(groupMessage('#currency help'));

        expect(text).toContain('#currency notify');
        expect(text).toContain('#currency game');
        expect(text).not.toContain('on|off');
        expect(text).not.toContain('add|remove');
    });

    it('前缀取自配置: 换个前缀, 帮助整体跟着换', async () => {
        pluginState.config = { ...pluginState.config, commandPrefix: '/cp' };

        const text = await helpText(privateMessage('/cp help'));

        expect(text).toContain('/cp notify');
        expect(text).not.toContain('#currency');
    });
});
