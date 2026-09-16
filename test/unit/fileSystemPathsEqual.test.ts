import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { fileSystemPathsEqual } from '../../src/common/fileSystemPathsEqual.ts';

describe('fileSystemPathsEqual', () => {
    it('returns true for identical paths', () => {
        assert.equal(fileSystemPathsEqual('d:/a/b.md', 'd:/a/b.md', false), true);
        assert.equal(fileSystemPathsEqual('d:\\a\\b.md', 'd:\\a\\b.md', true), true);
    });

    it('returns false for different paths', () => {
        assert.equal(fileSystemPathsEqual('d:/a/b.md', 'd:/a/c.md', false), false);
        assert.equal(fileSystemPathsEqual('d:/a/b.md', 'd:/a/c.md', true), false);
    });

    it('ignores case when the file system is case-insensitive', () => {
        assert.equal(fileSystemPathsEqual('d:\\Notes\\Report[1].MD', 'd:\\notes\\report[1].md', true), true);
    });

    it('respects case when the file system is case-sensitive', () => {
        assert.equal(fileSystemPathsEqual('/notes/Report.md', '/notes/report.md', false), false);
    });
});
