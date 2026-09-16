import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readJsonSafe, writeJsonAtomic } from '../../src/store/atomic-json';

let dir: string;
let file: string;

beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atomic-json-'));
    file = path.join(dir, 'data.json');
});

afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(dir, { recursive: true, force: true });
});

describe('writeJsonAtomic — 原子写', () => {
    it('写完的文件是完整的合法 JSON', () => {
        writeJsonAtomic(file, { version: 1, sessions: { 'group:1': { notifyEnabled: true } } }, 2);

        expect(JSON.parse(fs.readFileSync(file, 'utf-8'))).toEqual({
            version: 1,
            sessions: { 'group:1': { notifyEnabled: true } },
        });
    });

    it('覆盖写不留临时文件', () => {
        writeJsonAtomic(file, { n: 1 });
        writeJsonAtomic(file, { n: 2 });

        expect(fs.readdirSync(dir)).toEqual(['data.json']);
    });

    it('**写入被中断不产生半截文件**: 落盘失败时目标文件保持原内容, 且不残留临时文件', () => {
        writeJsonAtomic(file, { n: '旧值' }, 2);
        // 只在最后一步 rename 处注入失败——这正是"写到一半崩了"最接近的位置
        vi.spyOn(fs, 'renameSync').mockImplementation(() => {
            throw new Error('EIO: 磁盘写入被中断');
        });

        expect(() => writeJsonAtomic(file, { n: '新值' }, 2)).toThrow();

        expect(JSON.parse(fs.readFileSync(file, 'utf-8'))).toEqual({ n: '旧值' });
        expect(fs.readdirSync(dir)).toEqual(['data.json']);
    });
});

describe('readJsonSafe — 读取与损坏恢复', () => {
    it('文件不存在时返回兜底值, 且不创建文件', () => {
        const result = readJsonSafe(file, { version: 1, sessions: {} });

        expect(result).toEqual({ data: { version: 1, sessions: {} }, corrupted: false });
        expect(fs.existsSync(file)).toBe(false);
    });

    it('正常文件原样读出', () => {
        fs.writeFileSync(file, JSON.stringify({ version: 1, sessions: {} }), 'utf-8');

        expect(readJsonSafe(file, { version: 0, sessions: {} })).toEqual({
            data: { version: 1, sessions: {} },
            corrupted: false,
        });
    });

    it('**损坏时备份为 *.bak** 并返回兜底值, 不抛错', () => {
        fs.writeFileSync(file, '{ 这不是 JSON', 'utf-8');

        const result = readJsonSafe(file, { version: 1, sessions: {} });

        expect(result).toEqual({ data: { version: 1, sessions: {} }, corrupted: true });
        expect(fs.readFileSync(`${file}.bak`, 'utf-8')).toBe('{ 这不是 JSON');
    });

    it('已有 *.bak 时被新的损坏内容覆盖, 不抛错', () => {
        fs.writeFileSync(`${file}.bak`, '更早的一份损坏内容', 'utf-8');
        fs.writeFileSync(file, '坏', 'utf-8');

        expect(() => readJsonSafe(file, {})).not.toThrow();
        expect(fs.readFileSync(`${file}.bak`, 'utf-8')).toBe('坏');
    });
});
