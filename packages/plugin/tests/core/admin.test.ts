import { beforeEach, describe, expect, it } from 'vitest';
import type { OB11Message } from 'napcat-types/napcat-onebot';
import { hasRole, isSuperAdmin, getUserRole, type UserRole } from '../../src/core/admin';
import { pluginState } from '../../src/core/state';

/** 测试用的超管 QQ 号 */
const SUPER_ADMIN = '958341409';
/** 与超管无关的普通 QQ 号 */
const NOBODY = '10001';

function role(roleName: UserRole['role']): UserRole {
    return { userId: NOBODY, role: roleName, from: { id: NOBODY, type: 'private' } };
}

describe('hasRole — 线性比较', () => {
    it('同档通过', () => {
        expect(hasRole(role('admin'), 'admin')).toBe(true);
    });

    it('低档不通过', () => {
        expect(hasRole(role('user'), 'admin')).toBe(false);
        expect(hasRole(role('admin'), 'privateUser')).toBe(false);
        expect(hasRole(role('privateUser'), 'superAdmin')).toBe(false);
    });

    it('高档通过低档要求（超管能做 admin 级的事）', () => {
        expect(hasRole(role('superAdmin'), 'admin')).toBe(true);
        expect(hasRole(role('privateUser'), 'admin')).toBe(true);
    });

    it('档位全序: user(0) < admin(1) < privateUser(2) < superAdmin(3)', () => {
        const ladder: UserRole['role'][] = ['user', 'admin', 'privateUser', 'superAdmin'];

        ladder.forEach((lower, i) => {
            ladder.forEach((higher, j) => {
                expect(hasRole(role(higher), lower)).toBe(j >= i);
            });
        });
    });
});

describe('isSuperAdmin — 唯一需要配置的档位', () => {
    beforeEach(() => {
        pluginState.config = { ...pluginState.config, adminUsers: [SUPER_ADMIN] };
    });

    it('名单内为真、名单外为假', () => {
        expect(isSuperAdmin(SUPER_ADMIN)).toBe(true);
        expect(isSuperAdmin(NOBODY)).toBe(false);
    });

    it('按字符串比较 QQ 号（数字形式的入参也能命中）', () => {
        expect(isSuperAdmin(String(958341409))).toBe(true);
    });
});

// ==================== 消息事件夹具 ====================

function groupMessage(options: {
    userId?: string;
    groupId?: string;
    senderRole?: string;
} = {}): OB11Message {
    return {
        post_type: 'message',
        message_type: 'group',
        sub_type: 'normal',
        user_id: Number(options.userId ?? NOBODY),
        group_id: Number(options.groupId ?? '555'),
        raw_message: '',
        sender: { user_id: Number(options.userId ?? NOBODY), role: options.senderRole },
    } as unknown as OB11Message;
}

function privateMessage(options: { userId?: string; subType?: string } = {}): OB11Message {
    return {
        post_type: 'message',
        message_type: 'private',
        sub_type: options.subType ?? 'friend',
        user_id: Number(options.userId ?? NOBODY),
        raw_message: '',
        sender: { user_id: Number(options.userId ?? NOBODY) },
    } as unknown as OB11Message;
}

describe('getUserRole — 入口一次性推导', () => {
    beforeEach(() => {
        pluginState.config = { ...pluginState.config, adminUsers: [SUPER_ADMIN] };
    });

    it('超管在**别人的群里**也是 superAdmin（该档位的核心价值）', () => {
        const userRole = getUserRole(groupMessage({ userId: SUPER_ADMIN, groupId: '999' }));

        expect(userRole.role).toBe('superAdmin');
    });

    it('群管理员与群主是 admin，普通群成员是 user', () => {
        expect(getUserRole(groupMessage({ senderRole: 'admin' })).role).toBe('admin');
        expect(getUserRole(groupMessage({ senderRole: 'owner' })).role).toBe('admin');
        expect(getUserRole(groupMessage({ senderRole: 'member' })).role).toBe('user');
        expect(getUserRole(groupMessage()).role).toBe('user');
    });

    it('好友私聊是 privateUser（等同 admin 权限组）', () => {
        expect(getUserRole(privateMessage({ subType: 'friend' })).role).toBe('privateUser');
    });

    it('群临时会话是 user，不提权', () => {
        expect(getUserRole(privateMessage({ subType: 'group' })).role).toBe('user');
    });

    it('非好友、非群管理的陌生人一律是 user', () => {
        expect(getUserRole(privateMessage({ subType: 'other' })).role).toBe('user');
    });

    it('from 记录来源会话, 供作用域校验与回复目标复用', () => {
        expect(getUserRole(groupMessage({ groupId: '123456' })).from).toEqual({
            id: '123456',
            type: 'group',
        });
        expect(getUserRole(privateMessage({ userId: '789' })).from).toEqual({
            id: '789',
            type: 'private',
        });
    });
});
