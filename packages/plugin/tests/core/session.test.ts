import { describe, expect, it } from 'vitest';
import { sessionKeyOf } from '../../src/core/session';

describe('sessionKeyOf — 会话键', () => {
    it('群聊会话键形如 group:<群号>', () => {
        expect(sessionKeyOf({ id: '123456', type: 'group' })).toBe('group:123456');
    });

    it('私聊会话键形如 private:<QQ号>', () => {
        expect(sessionKeyOf({ id: '789', type: 'private' })).toBe('private:789');
    });

    it('**同一个 QQ 号的群聊与私聊是两个不同的会话**', () => {
        expect(sessionKeyOf({ id: '789', type: 'group' })).not.toBe(
            sessionKeyOf({ id: '789', type: 'private' }),
        );
    });
});
