/**
 * 归档维护的挂载点 —— `plugin_init`
 *
 * 见设计文档 §7.4 §12.4。核心回归项: **订阅并集为空时维护依然会执行**——维护挂在
 * init 而不是调度器上, 就是为了让归档生命周期不取决于"有没有人订阅"。
 */

import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { plugin_init } from '../../src/index';
import { createTestEnv, type TestEnv } from '../helpers/test-env';

let env: TestEnv;

beforeEach(() => {
    env = createTestEnv();
});

afterEach(() => {
    env.dispose();
});

/** 在归档目录下放一个昨天的归档文件（按本地日期推算） */
function seedYesterdayArchive(): void {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const pad = (value: number): string => String(value).padStart(2, '0');
    const date = `${yesterday.getFullYear()}-${pad(yesterday.getMonth() + 1)}-${pad(yesterday.getDate())}`;

    const dir = path.join(env.dataPath, 'archive');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${date}.json`), JSON.stringify({ date, runs: [] }), 'utf-8');
}

describe('plugin_init — 归档维护挂载', () => {
    it('加载完成后维护执行过一次: 昨天的归档被压缩', async () => {
        seedYesterdayArchive();

        await plugin_init(env.ctx);

        const dir = path.join(env.dataPath, 'archive');
        const files = fs.readdirSync(dir);
        expect(files.some((f) => f.endsWith('.json.gz'))).toBe(true);
        expect(files.some((f) => f.endsWith('.json'))).toBe(false);
    });

    it('没有任何会话订阅（state.json 为空）时, 维护依然执行——核心回归项', async () => {
        // state.json 从未写过: 订阅并集为空, 调度器不会启动
        seedYesterdayArchive();

        await plugin_init(env.ctx);

        const dir = path.join(env.dataPath, 'archive');
        expect(fs.readdirSync(dir).some((f) => f.endsWith('.json.gz'))).toBe(true);
    });
});
