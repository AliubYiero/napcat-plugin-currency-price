/**
 * 真实注册表的行为
 *
 * 与 `instruction.test.ts`（注入注册表、测分发层本身）互补: 这里测的是**本插件真正装上的
 * 那几条指令**——权限门槛、参数取值校验是否接对了。片 01 里只能靠注入注册表覆盖的
 * 「权限不足」「非法参数」两条路径, 从本片起是真实路径。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../../src/config';
import type { UserRole } from '../../src/core/admin';
import { pluginState } from '../../src/core/state';
import {
    registry,
    renderFailure,
    resolveInstruction,
    type DispatchOutcome,
} from '../../src/handlers/instruction';
import { createTestEnv, type TestEnv } from '../helpers/test-env';

let env: TestEnv;

/** 只配两个游戏, 好验证"匹配对象是 catalogs 而不是写死的清单" */
const CATALOG_NAMES = ['流放之路2', '流放之路1'];

beforeEach(() => {
    env = createTestEnv();
    env.init();
    pluginState.config = {
        ...DEFAULT_CONFIG,
        catalogs: CATALOG_NAMES.map((name) => ({
            name,
            pageUrl: `https://qiandao.com/${name}`,
            currencyList: [{ name: '神圣石', detail: false }],
            zoneConfigs: [['国服', '赛季', '普通']],
        })),
    };
});

afterEach(() => {
    env.dispose();
});

const groupMember: UserRole = {
    userId: '10001',
    role: 'user',
    from: { id: '555', type: 'group' },
};
const groupAdmin: UserRole = { ...groupMember, role: 'admin' };
const friend: UserRole = {
    userId: '10002',
    role: 'privateUser',
    from: { id: '10002', type: 'private' },
};

function dispatch(
    args: string[],
    role: UserRole = groupAdmin,
): DispatchOutcome {
    return resolveInstruction(role, args, registry);
}

describe('注册表 — notify', () => {
    it('`notify on|off` 是 admin 级: 群普通成员发就是权限不足', () => {
        expect(dispatch(['notify', 'on'], groupMember)).toEqual({
            kind: 'permission-denied',
            raw: 'notify on',
        });
        expect(dispatch(['notify', 'off'], groupMember)).toEqual({
            kind: 'permission-denied',
            raw: 'notify off',
        });
    });

    it('群管理员与好友私聊都能开关通知', () => {
        expect(dispatch(['notify', 'on']).kind).toBe('execute');
        expect(dispatch(['notify', 'off']).kind).toBe('execute');
        expect(dispatch(['notify', 'on'], friend).kind).toBe(
            'execute',
        );
    });

    it('`notify`（查看）是 user 级, 群普通成员也能看', () => {
        expect(dispatch(['notify'], groupMember).kind).toBe(
            'execute',
        );
    });

    it('**不认识的子指令是非法参数, 不是静默回落到查看**: `notify onn`', () => {
        expect(dispatch(['notify', 'onn'], groupMember)).toEqual({
            kind: 'invalid-args',
            arg: 'onn',
        });
    });
});

describe('注册表 — game', () => {
    it('`game add|remove` 是 admin 级: 群普通成员发就是权限不足', () => {
        expect(
            dispatch(['game', 'add', '流放之路2'], groupMember),
        ).toEqual({
            kind: 'permission-denied',
            raw: 'game add 流放之路2',
        });
        expect(
            dispatch(['game', 'remove', '流放之路2'], groupMember)
                .kind,
        ).toBe('permission-denied');
    });

    it('`game`（列出）是 user 级, 群普通成员也能看', () => {
        expect(dispatch(['game'], groupMember).kind).toBe('execute');
    });

    it('**游戏名精确匹配 catalogs**: 不在清单里的名字是非法参数', () => {
        expect(dispatch(['game', 'add', '原神'])).toEqual({
            kind: 'invalid-args',
            arg: '原神',
        });
        // 清单里有流放之路1、流放之路2, 但没有「流放之路」——前缀不算匹配
        expect(dispatch(['game', 'add', '流放之路'])).toEqual({
            kind: 'invalid-args',
            arg: '流放之路',
        });
    });

    it('在清单里的游戏名通过校验, 且游戏名原样传给 handler', () => {
        expect(dispatch(['game', 'add', '流放之路2'])).toEqual({
            kind: 'execute',
            definition: registry.namespaces.game.add,
            args: ['流放之路2'],
        });
    });

    it('**admin 门槛先于取值校验**: 无权者传非法名字回的是权限不足', () => {
        expect(
            dispatch(['game', 'add', '原神'], groupMember).kind,
        ).toBe('permission-denied');
    });

    it('缺游戏名是非法参数, 文案里不出现空参数', () => {
        expect(dispatch(['game', 'add']).kind).toBe('invalid-args');
        expect(
            renderFailure(dispatch(['game', 'add']), '#currency'),
        ).toBe(
            "#currency: 非法参数\n输入 '#currency help' 获取帮助信息",
        );
    });

    it('多给一个参数也是非法参数', () => {
        expect(
            dispatch(['game', 'add', '流放之路2', 'extra']),
        ).toEqual({
            kind: 'invalid-args',
            arg: 'extra',
        });
    });

    it('**退订不校验 catalogs**: 游戏被从配置里删掉后, 仍要能退订', () => {
        expect(
            dispatch(['game', 'remove', '已下架的游戏']).kind,
        ).toBe('execute');
    });

    it('不认识的子指令是非法参数: `game bogus`', () => {
        expect(dispatch(['game', 'bogus'])).toEqual({
            kind: 'invalid-args',
            arg: 'bogus',
        });
    });
});
