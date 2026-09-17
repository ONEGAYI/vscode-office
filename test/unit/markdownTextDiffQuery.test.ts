import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
    TEXT_DIFF_SCHEME,
    buildTextDiffQuery,
    parseTextDiffSourceQuery,
} from '../../src/service/markdown/textDiffQuery.ts';

describe('textDiffQuery', () => {
    it('roundtrips the source uri through build/parse', () => {
        const query = buildTextDiffQuery('file:///d:/notes/a.md', 1234);
        assert.match(query, /&t=1234$/);
        assert.equal(parseTextDiffSourceQuery(query), 'file:///d:/notes/a.md');
    });

    it('returns undefined when the src parameter is missing', () => {
        assert.equal(parseTextDiffSourceQuery('t=1234'), undefined);
        assert.equal(parseTextDiffSourceQuery(''), undefined);
    });

    it('returns undefined for a garbage src parameter', () => {
        assert.equal(parseTextDiffSourceQuery('src=%ZZ-not-a-query'), undefined);
    });

    it('exposes the scheme that matches no custom editor selector', () => {
        assert.equal(TEXT_DIFF_SCHEME, 'office-md-textdiff');
    });
});
