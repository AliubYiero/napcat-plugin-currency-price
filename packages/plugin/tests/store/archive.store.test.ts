/**
 * 归档存储 —— `archive/YYYY-MM-DD.json`
 *
 * 见设计文档 §7.3 §7.4。本片落定 run 级追加、生命周期（gzip / 30 天清理）与维护挂载。
 * `runs[].games` 与 `data.json` 的 `games` **同构**——测试里直接用 `scrapeGames` 的返回
 * 形状造数据, 保证"归档是 `data.json` 的历史切片"不是一句空话。
 */

import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ArchiveStore } from '../../src/store/archive.store';
import type { GameOk } from '../../src/store/data.store';
import { createTestEnv, type TestEnv } from '../helpers/test-env';

let env: TestEnv;
let store: ArchiveStore;

/** 一个成功的游戏抓取结果（与 `data.store.test.ts` 同款, 保持两处对同构的期待一致） */
function okResult(): GameOk {
    return {
        readAt: '2026-09-16T08:00:05.123Z',
        missing: [],
        zones: [
            {
                zone: ['国服', '赛季', '普通'],
                readAt: '2026-09-16T08:00:05.123Z',
                prices: [{ name: '神圣石', price: 0.2444, unit: '元/个' }],
            },
        ],
    };
}

beforeEach(() => {
    env = createTestEnv();
    env.init();
    store = ArchiveStore.getInstance();
});

afterEach(() => {
    env.dispose();
});

describe('ArchiveStore — run 级追加', () => {
    it('成功抓取后, 当天的归档文件里出现一条 run, `games` 只含本次实际抓取的游戏', () => {
        // 本地构造器造 now: 无论测试机在哪个时区, 本地日期都是 2026-09-16
        const now = new Date(2026, 8, 16, 12, 0, 0);

        store.recordRun(
            {
                startedAt: '2026-09-16T08:00:03.123Z',
                finishedAt: '2026-09-16T08:02:15.456Z',
                trigger: 'schedule',
                games: { 流放之路2: okResult() },
            },
            now,
        );

        expect(JSON.parse(env.readDataFile('archive/2026-09-16.json') ?? '{}')).toEqual({
            date: '2026-09-16',
            runs: [
                {
                    startedAt: '2026-09-16T08:00:03.123Z',
                    finishedAt: '2026-09-16T08:02:15.456Z',
                    trigger: 'schedule',
                    games: { 流放之路2: okResult() },
                },
            ],
        });
    });

    it('失败的游戏在 `runs[].games` 里记为 `{ "error": "..." }`', () => {
        const now = new Date(2026, 8, 16, 12, 0, 0);

        store.recordRun(
            {
                startedAt: '2026-09-16T08:00:03.123Z',
                finishedAt: '2026-09-16T08:02:15.456Z',
                trigger: 'schedule',
                games: {
                    流放之路2: okResult(),
                    火炬之光: { error: '切换到 赛季 / 普通 失败：Timeout 20000ms exceeded' },
                },
            },
            now,
        );

        const archive = JSON.parse(env.readDataFile('archive/2026-09-16.json') ?? '{}');
        expect(archive.runs[0].games['火炬之光']).toEqual({
            error: '切换到 赛季 / 普通 失败：Timeout 20000ms exceeded',
        });
    });

    it('全部游戏失败时不写归档', () => {
        const now = new Date(2026, 8, 16, 12, 0, 0);

        store.recordRun(
            {
                startedAt: '2026-09-16T08:00:03.123Z',
                finishedAt: '2026-09-16T08:02:15.456Z',
                trigger: 'schedule',
                games: { 火炬之光: { error: '浏览器不可用' } },
            },
            now,
        );

        expect(env.readDataFile('archive/2026-09-16.json')).toBeNull();
    });

    it('第二次抓取追加到同一天的文件里, 不覆盖之前的 run', () => {
        const now = new Date(2026, 8, 16, 12, 0, 0);
        const run = (trigger: string): Parameters<ArchiveStore['recordRun']>[0] => ({
            startedAt: '2026-09-16T08:00:03.123Z',
            finishedAt: '2026-09-16T08:02:15.456Z',
            trigger,
            games: { 流放之路2: okResult() },
        });

        store.recordRun(run('schedule'), now);
        store.recordRun(run('manual:group:123456'), now);

        const archive = JSON.parse(env.readDataFile('archive/2026-09-16.json') ?? '{}');
        expect(archive.runs).toHaveLength(2);
        expect(archive.runs.map((r: RunRecord) => r.trigger)).toEqual([
            'schedule',
            'manual:group:123456',
        ]);
    });
});

describe('ArchiveStore — 生命周期维护', () => {
    /** 在归档目录下放一个给定日期的 `.json` 归档文件, 返回其路径 */
    function seedArchive(date: string): string {
        const dir = path.join(env.dataPath, 'archive');
        fs.mkdirSync(dir, { recursive: true });
        const filePath = path.join(dir, `${date}.json`);
        fs.writeFileSync(filePath, JSON.stringify({ date, runs: [] }), 'utf-8');

        return filePath;
    }

    it('昨天的归档被 gzip 成 `.json.gz`, 原 `.json` 被删除, 内容不变', async () => {
        seedArchive('2026-09-15');
        const now = new Date(2026, 8, 16, 12, 0, 0);

        await store.runMaintenance(now);

        const dir = path.join(env.dataPath, 'archive');
        expect(fs.existsSync(path.join(dir, '2026-09-15.json'))).toBe(false);
        expect(fs.existsSync(path.join(dir, '2026-09-15.json.gz'))).toBe(true);

        const gunzipped = JSON.parse(
            zlib.gunzipSync(fs.readFileSync(path.join(dir, '2026-09-15.json.gz'))).toString(),
        );
        expect(gunzipped).toEqual({ date: '2026-09-15', runs: [] });
    });

    it('恰好 30 天的 `.json.gz` 保留, 超过 30 天的清理（边界取"超过"）', () => {
        const dir = path.join(env.dataPath, 'archive');
        fs.mkdirSync(dir, { recursive: true });
        // now = 2026-09-16 → 恰好 30 天前是 2026-08-17, 超过 30 天是 2026-08-16
        for (const date of ['2026-08-17', '2026-08-16']) {
            fs.writeFileSync(path.join(dir, `${date}.json.gz`), 'gz', 'utf-8');
        }
        const now = new Date(2026, 8, 16, 12, 0, 0);

        store.runMaintenance(now);

        expect(fs.existsSync(path.join(dir, '2026-08-17.json.gz'))).toBe(true);
        expect(fs.existsSync(path.join(dir, '2026-08-16.json.gz'))).toBe(false);
    });

    it('今天的归档不压缩, 只处理昨天之前的', async () => {
        seedArchive('2026-09-16');
        seedArchive('2026-09-15');
        const now = new Date(2026, 8, 16, 12, 0, 0);

        await store.runMaintenance(now);

        const dir = path.join(env.dataPath, 'archive');
        expect(fs.existsSync(path.join(dir, '2026-09-16.json'))).toBe(true);
        expect(fs.existsSync(path.join(dir, '2026-09-15.json'))).toBe(false);
    });

    it('gzip 失败时保留未压缩文件, 其余归档照常处理, 且不抛错', async () => {
        const dir = path.join(env.dataPath, 'archive');
        seedArchive('2026-09-14');
        seedArchive('2026-09-15');
        // 占住目标 `.json.gz` 路径: 写入流必然失败, 模拟磁盘层面的压缩失败
        fs.mkdirSync(path.join(dir, '2026-09-15.json.gz'));
        const now = new Date(2026, 8, 16, 12, 0, 0);

        await expect(store.runMaintenance(now)).resolves.toBeUndefined();

        // 失败的原文件保留, 等下次维护重试
        expect(fs.existsSync(path.join(dir, '2026-09-15.json'))).toBe(true);
        expect(fs.existsSync(path.join(dir, '2026-09-15.json.gz'))).toBe(true); // 目录桩
        // 一个失败不拖累其余维护
        expect(fs.existsSync(path.join(dir, '2026-09-14.json'))).toBe(false);
        expect(fs.existsSync(path.join(dir, '2026-09-14.json.gz'))).toBe(true);
    });

    it('损坏的归档文件不阻塞维护', async () => {
        const dir = path.join(env.dataPath, 'archive');
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, '2026-09-14.json'), '{ 半截 JSON', 'utf-8');
        seedArchive('2026-09-15');
        const now = new Date(2026, 8, 16, 12, 0, 0);

        await expect(store.runMaintenance(now)).resolves.toBeUndefined();
        expect(fs.existsSync(path.join(dir, '2026-09-15.json'))).toBe(false);
    });
});
