import { describe, expect, it } from 'vitest';
import { stripAtBotPrefix } from '../../src/handlers/at-bot-prefix';

/** 机器人自身 QQ 号 (实际取自 PluginState.selfId, 不硬编码) */
const BOT = '268491285';

describe('stripAtBotPrefix — 剥离规则', () => {
    it('剥离开头匹配 selfId 的 at CQ 段', () => {
        expect(stripAtBotPrefix(`[CQ:at,qq=${BOT}] #currency help`, BOT)).toBe(' #currency help');
    });

    it('只剥离**第一个** at 段, 其余 at 段原样保留', () => {
        const raw = `[CQ:at,qq=${BOT}] [CQ:at,qq=10001] #currency help`;

        expect(stripAtBotPrefix(raw, BOT)).toBe(' [CQ:at,qq=10001] #currency help');
    });

    it('CQ 标记大小写不敏感', () => {
        expect(stripAtBotPrefix(`[cq:at,qq=${BOT}] #cmd`, BOT)).toBe(' #cmd');
        expect(stripAtBotPrefix(`[Cq:At,qq=${BOT}] #cmd`, BOT)).toBe(' #cmd');
    });

    it('qq 值可带单引号、双引号或无引号', () => {
        expect(stripAtBotPrefix(`[CQ:at,qq="${BOT}"] #cmd`, BOT)).toBe(' #cmd');
        expect(stripAtBotPrefix(`[CQ:at,qq='${BOT}'] #cmd`, BOT)).toBe(' #cmd');
        expect(stripAtBotPrefix(`[CQ:at,qq=${BOT}] #cmd`, BOT)).toBe(' #cmd');
    });

    it('属性顺序不限, 且允许额外属性', () => {
        expect(stripAtBotPrefix(`[CQ:at,name=bot,qq=${BOT}] #cmd`, BOT)).toBe(' #cmd');
        expect(stripAtBotPrefix(`[CQ:at,qq=${BOT},name=bot] #cmd`, BOT)).toBe(' #cmd');
    });

    it('qq 值必须**精确等于** selfId, 前缀相同不算命中', () => {
        expect(stripAtBotPrefix(`[CQ:at,qq=${BOT}0] #cmd`, BOT)).toBe(`[CQ:at,qq=${BOT}0] #cmd`);
        expect(stripAtBotPrefix(`[CQ:at,qq=0${BOT}] #cmd`, BOT)).toBe(`[CQ:at,qq=0${BOT}] #cmd`);
    });

    it('at 的是别人时不动', () => {
        expect(stripAtBotPrefix('[CQ:at,qq=10001] #cmd', BOT)).toBe('[CQ:at,qq=10001] #cmd');
    });

    it('非 at 的 CQ 段开头不动', () => {
        expect(stripAtBotPrefix('[CQ:image,file=a.png] #cmd', BOT)).toBe(
            '[CQ:image,file=a.png] #cmd',
        );
    });

    it('at 段不在开头时不动', () => {
        expect(stripAtBotPrefix(`你好 [CQ:at,qq=${BOT}] #cmd`, BOT)).toBe(
            `你好 [CQ:at,qq=${BOT}] #cmd`,
        );
    });

    it('selfId 缺失或无效时原样返回, 不抛异常', () => {
        const raw = `[CQ:at,qq=${BOT}] #cmd`;

        expect(stripAtBotPrefix(raw, '')).toBe(raw);
        expect(stripAtBotPrefix(raw, undefined as unknown as string)).toBe(raw);
        expect(stripAtBotPrefix(raw, null as unknown as string)).toBe(raw);
    });

    it('函数本身不做 trim/trimStart——那是接收层的编排职责', () => {
        expect(stripAtBotPrefix(`[CQ:at,qq=${BOT}] #cmd`, BOT)).toBe(' #cmd');
    });
});

describe('接收层的规范化编排', () => {
    it('trim → 剥离 → trimStart 后, @机器人 + 指令 可正常触发', () => {
        const raw = `  [CQ:at,qq=${BOT}] #currency help  `;

        const normalized = stripAtBotPrefix(raw.trim(), BOT).trimStart();

        expect(normalized).toBe('#currency help');
    });

    it('@机器人 但未跟指令时, 只剩下空白', () => {
        const normalized = stripAtBotPrefix(`[CQ:at,qq=${BOT}]`.trim(), BOT).trimStart();

        expect(normalized.trim()).toBe('');
    });
});
