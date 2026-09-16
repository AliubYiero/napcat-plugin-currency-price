import { describe, expect, it } from 'vitest';
import type { UserRole } from '../../../src/core/admin';
import { getHelpVariant } from '../../../src/handlers/currency/help.handler';

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
